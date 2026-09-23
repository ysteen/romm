const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

function loadClass(file, name, context = {}) {
    const source = readFileSync(require.resolve("../data/src/" + file), "utf8")
        .replace(/^import .*;$/gm, "")
        .replace(/^export .*;$/gm, "");
    return runInNewContext(source + "\n" + name, {
        Uint8Array, File, Error, Map, console, clearTimeout, setTimeout,
        ...context
    });
}
const Manager = loadClass("GameManager.js", "EJS_GameManager");
const Emulator = loadClass("emulator.js", "EmulatorJS");

function stateRuntime() {
    const runtime = Object.create(Emulator.prototype);
    const events = [];
    Object.assign(runtime, {
        started: true, paused: true, debug: false, functions: {},
        getCore: () => "azahar", localization: value => value,
        displayMessage: message => events.push(message),
        play() { this.paused = false; }, pause() { this.paused = true; },
        gameManager: {
            getState: async () => new Uint8Array([1, 2]),
            screenshot: async () => new Uint8Array([3]),
            loadState: async () => {}
        }
    });
    return { runtime, events };
}

test("toolbar saves await RomM upload, preserve pause and suppress overlapping captures", async () => {
    const { runtime } = stateRuntime();
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const uploads = [];
    const bytes = new Uint8Array([1, 2]);
    runtime.gameManager.getState = () => bytes;
    runtime.on("saveState", async data => { uploads.push(data); await pending; });
    const saving = runtime.saveState();
    await new Promise(resolve => setTimeout(resolve, 0));
    bytes[0] = 9;
    assert.equal(runtime.paused, false);
    assert.equal(runtime.stateActionPending, true);
    await runtime.saveState();
    await runtime.loadState();
    assert.equal(uploads.length, 1);
    assert.deepEqual(uploads[0].state, new Uint8Array([1, 2]));
    release();
    await saving;
    assert.equal(runtime.paused, true);
    assert.equal(runtime.stateActionPending, false);
});

test("a failed preview does not prevent the normal server save event", async () => {
    const { runtime } = stateRuntime();
    runtime.gameManager.screenshot = async () => { throw Error("no preview"); };
    const uploads = [];
    runtime.on("saveState", data => uploads.push(data));
    await runtime.saveState();
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].screenshot, undefined);
});

test("empty captures and failed server uploads report failure and release the operation", async () => {
    const { runtime, events } = stateRuntime();
    let uploads = 0;
    runtime.on("saveState", () => { uploads++; throw Error("server failure"); });
    runtime.gameManager.getState = () => new Uint8Array();
    await runtime.saveState();
    assert.equal(uploads, 0);
    runtime.gameManager.getState = () => new Uint8Array([1]);
    await runtime.saveState();
    assert.equal(uploads, 1);
    assert.deepEqual(events, ["FAILED TO SAVE STATE", "FAILED TO SAVE STATE"]);
    assert.equal(runtime.paused, true);
    assert.equal(runtime.stateActionPending, false);
});

test("load toolbar delegates to RomM without falling back to browser storage", async () => {
    const { runtime } = stateRuntime();
    let opened = 0;
    runtime.on("loadState", () => { opened++; });
    await runtime.loadState();
    assert.equal(opened, 1);
});

test("closing the player during capture never dispatches a server upload", async () => {
    const { runtime } = stateRuntime();
    runtime.gameManager.getState = () => { runtime.started = false; return new Uint8Array([1]); };
    runtime.on("saveState", () => { throw Error("stale upload"); });
    await runtime.saveState();
    assert.equal(runtime.stateActionPending, false);
});

test("backend menu exposes all GPU options with supported values and actual core state", () => {
    const { runtime } = stateRuntime();
    runtime.gameManager.getCoreOptions = () => [
        "citra_graphics_api|OpenGL; auto|Software|OpenGL|Vulkan",
        "citra_use_hw_shaders|enabled; enabled|disabled",
        "citra_use_webgl_hw_draw|disabled; disabled|enabled",
        "citra_resolution_factor|2; 1|2|3", "", "malformed", "fixed|only; only"
    ].join("\n");
    const options = JSON.parse(JSON.stringify(runtime.getBackendCoreOptions()));
    assert.deepEqual(options.slice(0, 3), [
        { key: "citra_graphics_api", title: "Graphics API", values: ["auto", "OpenGL"], current: "OpenGL" },
        { key: "citra_use_hw_shaders", title: "Hardware Shaders", values: ["enabled", "disabled"], current: "enabled" },
        { key: "citra_use_webgl_hw_draw", title: "WebGL Hardware Draw", values: ["disabled", "enabled"], current: "disabled" }
    ]);
    assert.equal(options.length, 4);
    assert.equal(options[3].current, "2");
    runtime.getCore = () => "snes9x";
    assert.equal(runtime.getBackendCoreOptions()[0].values.includes("Vulkan"), true);
});

function manager(core = "azahar", result = 1) {
    const files = new Map();
    const calls = [];
    const gm = Object.create(Manager.prototype);
    const mount = { idbPersistState: 0 };
    gm.EJS = { getCore: () => core, config: {} };
    gm.FS = {
        filesystems: { IDBFS: { queuePersist() {} } },
        lookupPath: () => ({ node: { mount } }),
        writeFile: (path, data) => files.set(path, data),
        readFile: path => { if (!files.has(path)) throw Error("missing"); return files.get(path); },
        unlink: path => files.delete(path),
        analyzePath: path => ({ exists: files.has(path) }),
        mkdir: () => {},
        syncfs: (_, callback) => callback(null)
    };
    gm.Module = {
        _load_state_sync() {},
        EmulatorJSGetState: () => new Uint8Array([1, 2]),
        cwrap: name => path => { calls.push([name, path]); assert.ok(files.has(path)); return result; }
    };
    gm.functions = { supportsStates: () => 1, loadState: () => { throw Error("must not queue"); } };
    return { gm, files, calls };
}

test("Azahar states require the safe native restore export", () => {
    const { gm } = manager();
    assert.equal(gm.supportsStates(), true);
    delete gm.Module._load_state_sync;
    assert.equal(gm.supportsStates(), false);
    assert.throws(() => gm.loadState(new Uint8Array([1])), /Update the core/);
    assert.throws(() => gm.getState(), /Update the core/);
});
test("Azahar captures reject empty serialization results", () => {
    const { gm } = manager();
    assert.deepEqual(gm.getState(), new Uint8Array([1, 2]));
    gm.Module.EmulatorJSGetState = () => new Uint8Array();
    assert.throws(() => gm.getState(), /could not capture/);
});
test("Azahar load waits for a positive native result and immediately removes temporary data", () => {
    const { gm, calls, files } = manager();
    gm.loadState(new Uint8Array([1]));
    assert.deepEqual(calls, [["load_state_sync", "/azahar-manual.state"]]);
    assert.equal(files.size, 0);
});
test("Azahar failure throws rather than reporting an accepted queued task", () => {
    const { gm, files } = manager("azahar", 0);
    assert.throws(() => gm.loadState(new Uint8Array([1])), /rejected the state/);
    assert.equal(files.size, 0);
});
test("Azahar rejects malformed or oversized bytes before writing", () => {
    const { gm, files, calls } = manager();
    for (const data of [null, [], new Uint8Array(), { byteLength: 300 * 1024 * 1024 }]) {
        assert.throws(() => gm.loadState(data), /Invalid Azahar state size/);
    }
    assert.equal(files.size, 0);
    assert.equal(calls.length, 0);
});
test("Azahar quick-load also uses the synchronous checked export", () => {
    const { gm, files, calls } = manager();
    files.set("/1-quick.state", new Uint8Array([1]));
    assert.equal(gm.quickLoad(1), true);
    assert.equal(calls[0][0], "load_state_sync");
});
test("Azahar state hotkeys use the same RomM-aware actions as the toolbar", () => {
    const { gm } = manager();
    const actions = [];
    gm.EJS.saveState = () => actions.push("save");
    gm.EJS.loadState = () => actions.push("load");
    gm.quickLoad = gm.quickSave = () => { throw Error("unexpected local quick-state action"); };
    for (const index of [24, 25]) {
        gm.simulateInput(0, index, 1);
        gm.simulateInput(0, index, 0);
    }
    assert.deepEqual(actions, ["save", "load"]);
});
test("other cores keep upstream state support semantics", () => {
    const { gm } = manager("snes9x");
    delete gm.Module._load_state_sync;
    assert.equal(gm.supportsStates(), true);
});

function importer(helper, context = {}) {
    const Emulator = loadClass("emulator.js", "EmulatorJS", { EJS_AzaharSystemData: helper, ...context });
    const emulator = Object.create(Emulator.prototype);
    const result = manager();
    emulator.gameManager = result.gm;
    return { emulator, ...result };
}
test("server system data uses authenticated cache revalidation on every launch", async () => {
    const entries = [{ filename: "/data/saves/Azahar/Azahar/nand/title/test.app", bytes: new Uint8Array([3]) }];
    const requests = [];
    const { emulator, files } = importer({
        MAX_ARCHIVE_BYTES: 128,
        extractZip: async bytes => { assert.deepEqual(Array.from(bytes), [80, 75]); return []; },
        prepareFiles: () => entries
    }, {
        fetch: async (url, options) => {
            requests.push([url, options.credentials, options.cache]);
            return new Response(new Uint8Array([80, 75]));
        }
    });
    const url = "/api/firmware/902/content/azahar-mii-system-data.zip";
    await emulator.downloadAzaharSystemData(url);
    await emulator.downloadAzaharSystemData(url);
    assert.deepEqual(requests, [[url, "same-origin", "no-cache"], [url, "same-origin", "no-cache"]]);
    assert.deepEqual([...files.keys()], [entries[0].filename]);
});
test("a failed server system-data response does not alter installed files", async () => {
    const { emulator, files } = importer({ MAX_ARCHIVE_BYTES: 128 }, {
        fetch: async () => new Response(null, { status: 404 })
    });
    files.set("/existing.app", new Uint8Array([9]));
    await assert.rejects(emulator.downloadAzaharSystemData("/api/firmware/902/content/missing.zip"), /Could not download/);
    assert.deepEqual([...files.keys()], ["/existing.app"]);
    assert.deepEqual(files.get("/existing.app"), new Uint8Array([9]));
});
test("system-data validation failure makes no NAND writes", async () => {
    const { emulator, files } = importer({
        MAX_ARCHIVE_BYTES: 128,
        extractZip: async () => [],
        prepareFiles: () => { throw Error("invalid title"); }
    });
    await assert.rejects(emulator.downloadAzaharSystemData(new File(["zip"], "system.zip")), /invalid title/);
    assert.equal(files.size, 0);
});
test("system-data install persists only the validated mapped files", async () => {
    const entries = [{ filename: "/data/saves/Azahar/Azahar/nand/title/test.app", bytes: new Uint8Array([3]) }];
    const { emulator, files, gm } = importer({ MAX_ARCHIVE_BYTES: 128, extractZip: async () => [], prepareFiles: () => entries });
    let synced = false;
    gm.FS.syncfs = (populate, callback) => { assert.equal(populate, false); synced = true; callback(null); };
    await emulator.downloadAzaharSystemData(new File(["zip"], "system.zip"));
    assert.deepEqual([...files.keys()], [entries[0].filename]);
    assert.equal(synced, true);
});
test("persistence failure rolls back replaced and newly added system files", async () => {
    const entries = [
        { filename: "/old.app", bytes: new Uint8Array([3]) },
        { filename: "/new.tmd", bytes: new Uint8Array([4]) }
    ];
    const { emulator, files, gm } = importer({ MAX_ARCHIVE_BYTES: 128, extractZip: async () => [], prepareFiles: () => entries });
    files.set("/old.app", new Uint8Array([1]));
    let syncs = 0;
    gm.FS.syncfs = (_, callback) => callback(++syncs === 1 ? Error("quota") : null);
    await assert.rejects(emulator.downloadAzaharSystemData(new File(["zip"], "system.zip")), /quota/);
    assert.deepEqual(files.get("/old.app"), new Uint8Array([1]));
    assert.equal(files.has("/new.tmd"), false);
    assert.equal(syncs, 2);
});
test("system import suspends only this mount's auto-persist hooks and restores them", async () => {
    const { gm } = manager();
    const mount = gm.FS.lookupPath().node.mount;
    const otherMount = {};
    const calls = [];
    const original = gm.FS.filesystems.IDBFS.queuePersist = candidate => calls.push(candidate);
    await assert.rejects(gm.withAzaharSystemDataTransaction(async () => {
        gm.FS.filesystems.IDBFS.queuePersist(mount);
        gm.FS.filesystems.IDBFS.queuePersist(otherMount);
        assert.deepEqual(calls, [otherMount]);
        throw Error("failure");
    }), /failure/);
    assert.equal(gm.FS.filesystems.IDBFS.queuePersist, original);
    assert.deepEqual(calls, [otherMount, mount]);
    assert.equal(gm.azaharImportPending, false);
});
test("system import waits for a previously scheduled persistence operation", async () => {
    const { gm } = manager();
    const mount = gm.FS.lookupPath().node.mount;
    mount.idbPersistState = 'idb';
    setTimeout(() => { mount.idbPersistState = 0; }, 10);
    await gm.withAzaharSystemDataTransaction(async () => assert.equal(mount.idbPersistState, 0));
});
