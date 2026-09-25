const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

function loadClass(file, name) {
    const source = readFileSync(require.resolve("../data/src/" + file), "utf8")
        .replace(/^import .*;$/gm, "").replace(/^export .*;$/gm, "");
    return runInNewContext(source + "\n" + name, { Uint8Array, TextEncoder, Date, console });
}
const Manager = loadClass("GameManager.js", "EJS_GameManager");
const Emulator = loadClass("emulator.js", "EmulatorJS");
const sdRoot = "Azahar/Azahar/sdmc/Nintendo 3DS/" + "0".repeat(32) + "/" + "0".repeat(32);
const titleRoot = sdRoot + "/title/00040000/0011aa00/data";
const extRoot = sdRoot + "/extdata/00000000/000011AA";

// Python's standard ZIP reader checks the real central directory and CRCs,
// independently of the writer. Fixtures use DEFLATE like Argosy's archiver.
function unzip(bytes) {
    const output = execFileSync("python3", ["-c", [
        "import io,json,sys,zipfile",
        "z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))",
        "assert z.testzip() is None",
        "print(json.dumps({n:list(z.read(n)) for n in z.namelist()}))"
    ].join("\n")], { input: Buffer.from(bytes) });
    return Object.fromEntries(Object.entries(JSON.parse(output)).map(([name, data]) => [name, new Uint8Array(data)]));
}
function zip(files) {
    return new Uint8Array(execFileSync("python3", ["-c", [
        "import io,json,sys,zipfile",
        "out=io.BytesIO()",
        "with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:",
        " for name,data in json.load(sys.stdin).items(): z.writestr(name,bytes(data))",
        "sys.stdout.buffer.write(out.getvalue())"
    ].join("\n")], { input: JSON.stringify(files) }));
}

function ncch({ cartridge = false, extdataId, extended = false, encrypted = false } = {}) {
    const offset = cartridge ? 0x4000 : 0;
    const bytes = new Uint8Array(offset + 0xa00);
    const view = new DataView(bytes.buffer);
    if (cartridge) {
        view.setUint32(0x100, 0x4453434e, true);
        view.setUint32(0x120, offset / 0x200, true);
    }
    view.setUint32(offset + 0x100, 0x4843434e, true);
    view.setUint32(offset + 0x118, 0x0011aa00, true);
    view.setUint32(offset + 0x11c, 0x00040000, true);
    if (extdataId !== undefined) {
        view.setUint32(offset + 0x180, 0x400, true);
        view.setUint8(offset + 0x18f, encrypted ? 0 : 4);
        view.setBigUint64(offset + (extended ? 0x440 : 0x430), BigInt(extdataId), true);
        view.setUint8(offset + 0x44f, extended ? 2 : 0);
    }
    return bytes;
}

function manager(core, rom = ncch()) {
    const files = new Map();
    const writes = [];
    const reads = [];
    const gm = Object.create(Manager.prototype);
    const add = (path, data, mtime = Date.now()) => files.set(path, { bytes: new Uint8Array(data), mtime: new Date(mtime) });
    const exists = path => files.has(path) || [...files.keys()].some(name => name.startsWith(path + "/"));
    gm.saveSessionStartedAt = Date.now();
    gm.EJS = {
        getCore: () => core, fileName: "game.3ds", config: {},
        compression: { decompress: async bytes => unzip(bytes) },
        downloadType: { support: { name: "support", dontCache: true } }
    };
    gm.FS = {
        analyzePath: path => ({ exists: exists(path) }),
        mkdir() {},
        stat: path => ({ mode: files.has(path) ? 1 : 2, mtime: files.get(path)?.mtime }),
        isFile: mode => mode === 1,
        isDir: mode => mode === 2,
        readdir: path => [".", "..", ...new Set([...files.keys()]
            .filter(name => name.startsWith(path + "/"))
            .map(name => name.substring(path.length + 1).split("/")[0]))],
        readFile: path => { assert.ok(files.has(path), path); return files.get(path).bytes; },
        writeFile: (path, bytes) => { writes.push(path); add(path, bytes); },
        syncfs: (populate, done) => { assert.equal(populate, false); done(null); },
        open: path => path,
        close() {},
        read: (path, bytes, start, length, offset) => {
            reads.push(length);
            const data = files.get(path).bytes.subarray(offset, offset + length);
            bytes.set(data, start);
            return data.length;
        }
    };
    gm.functions = { getSaveFilePath: () => "/data/saves/DOSBox-pure/Example.srm" };
    gm.loadSaveFiles = () => {};
    if (core === "azahar") add("/game.3ds", rom);
    return { gm, files, writes, reads, add };
}

test("PSP ZIP roots match Argosy and retain all files of each changed save folder", async () => {
    const { gm, add } = manager("ppsspp");
    const root = "/data/saves/PPSSPP/PSP/SAVEDATA/";
    add(root + "ULUS12345DATA/DATA.BIN", [1, 2]);
    add(root + "ULUS12345DATA/PARAM.SFO", [3], 0);
    add(root + "ULUS12345SYSTEM/PARAM.SFO", [4]);
    add(root + "ULES99999DATA/OTHER.BIN", [9], 0);
    const bytes = gm.getSaveFile(false);
    assert.equal(gm.getSaveFileName(bytes), "Example.zip");
    assert.deepEqual(Object.keys(unzip(bytes)).sort(), [
        "ULUS12345DATA/DATA.BIN", "ULUS12345DATA/PARAM.SFO", "ULUS12345SYSTEM/PARAM.SFO"
    ]);
    const target = manager("ppsspp");
    await target.gm.loadDirectorySaveBundle(bytes);
    assert.deepEqual([...target.files.get(root + "ULUS12345DATA/DATA.BIN").bytes], [1, 2]);
});

for (const cartridge of [false, true]) {
    test(`Azahar exports data/extdata for the loaded ${cartridge ? "NCSD" : "NCCH"} title only`, async () => {
        const { gm, add, reads } = manager("azahar", ncch({ cartridge }));
        add("/data/saves/" + titleRoot + "/00000001/main", [1, 2], 0);
        add("/data/saves/" + titleRoot + "/00000001.metadata", [3], 0);
        add("/data/saves/" + extRoot + "/user/progress", [4], 0);
        add("/data/saves/" + sdRoot + "/title/00040000/99999999/data/main", [9]);
        add("/data/saves/Azahar/Azahar/nand/title/system.app", [8]);
        add("/data/saves/" + titleRoot.replace(/data$/, "content") + "/game.app", [7]);
        const bytes = gm.getSaveFile(false);
        assert.deepEqual(Object.keys(unzip(bytes)).sort(), [
            "data/00000001.metadata", "data/00000001/main", "extdata/user/progress"
        ]);
        assert.ok(reads.every(size => size <= 512));
        const target = manager("azahar", ncch({ cartridge }));
        await target.gm.loadDirectorySaveBundle(bytes);
        assert.deepEqual([...target.files.get("/data/saves/" + titleRoot + "/00000001/main").bytes], [1, 2]);
        assert.deepEqual([...target.files.get("/data/saves/" + extRoot + "/user/progress").bytes], [4]);
    });
}

test("Azahar honors ExHeader extdata IDs, including extended savedata access", () => {
    for (const options of [
        { extdataId: 0xabcden },
        { extdataId: 0xabcden << 20n, extended: true }
    ]) {
        const { gm } = manager("azahar", ncch(options));
        assert.equal(gm.getAzaharSaveRoots().extdata, sdRoot + "/extdata/00000000/000ABCDE");
    }
    assert.equal(manager("azahar", ncch({ extdataId: 0 })).gm.getAzaharSaveRoots().extdata, undefined);
    assert.equal(manager("azahar", ncch({ extdataId: 0xabcdefn, encrypted: true })).gm.getAzaharSaveRoots().extdata, extRoot);
});

test("Argosy DEFLATE archives with directory entries restore in both emulators", async () => {
    for (const [core, entries, expected] of [
        ["ppsspp", { "ULUS12345/": [], "ULUS12345/DATA.BIN": [1] }, "PPSSPP/PSP/SAVEDATA/ULUS12345/DATA.BIN"],
        ["azahar", { "data/": [], "data/00000001/main": [1] }, titleRoot + "/00000001/main"],
        ["azahar", { "extdata/": [], "extdata/user/progress": [1] }, extRoot + "/user/progress"]
    ]) {
        const { gm, files } = manager(core);
        await gm.loadDirectorySaveBundle(zip(entries));
        assert.deepEqual([...files.get("/data/saves/" + expected).bytes], [1]);
    }
});

test("legacy runtime-path ZIPs still restore, regardless of their old .srm filename", async () => {
    for (const [core, path] of [
        ["ppsspp", "PPSSPP/PSP/SAVEDATA/ULUS12345/DATA.BIN"],
        ["azahar", titleRoot + "/00000001/main"],
        ["dosbox_pure", "DOSBox-pure/Example.pure.zip"]
    ]) {
        const { gm, files } = manager(core);
        await gm.loadDirectorySaveBundle(zip({ [path]: [1, 2, 3] }));
        assert.deepEqual([...files.get("/data/saves/" + path).bytes], [1, 2, 3]);
    }
});

test("DOSBox preserves disk deltas and sibling save files in its outer ZIP", async () => {
    const { gm, add } = manager("dosbox_pure");
    const delta = zip({ "GAME/SAVE.DAT": [7] });
    add("/data/saves/DOSBox-pure/Example.pure.zip", delta);
    add("/data/saves/DOSBox-pure/Example-CDRIVE.sav", [8]);
    add("/data/saves/DOSBox-pure/Example-1234.sav", [6]);
    add("/data/saves/DOSBox-pure/Another.pure.zip", [9]);
    const bundle = gm.getSaveFile(false);
    const entries = unzip(bundle);
    assert.equal(gm.getSaveFileName(bundle), "Example.zip");
    assert.deepEqual(Object.keys(entries).sort(), [
        "DOSBox-pure/Example-1234.sav", "DOSBox-pure/Example-CDRIVE.sav", "DOSBox-pure/Example.pure.zip"
    ]);
    assert.deepEqual(entries["DOSBox-pure/Example.pure.zip"], delta);
    const target = manager("dosbox_pure");
    await target.gm.loadDirectorySaveBundle(bundle);
    assert.deepEqual(target.files.get("/data/saves/DOSBox-pure/Example.pure.zip").bytes, delta);
});

test("ordinary SRAM filenames and bytes stay unchanged", () => {
    const { gm, add } = manager("snes9x");
    add(gm.getSaveFilePath(), [1, 2, 3]);
    assert.deepEqual([...gm.getSaveFile(false)], [1, 2, 3]);
    assert.equal(gm.getSaveFileName(gm.getSaveFile(false)), "Example.srm");
    assert.equal(manager("ppsspp").gm.getSaveFile(false), null);
    assert.equal(manager("azahar").gm.getSaveFile(false), null);
});

test("unsafe or colliding paths are rejected before any save is written", () => {
    for (const bad of ["../file", "data/../../file", "/data/file", "C:\\file", "data//file", "data/./file", "data/\0file"]) {
        const { gm, writes } = manager("azahar");
        assert.throws(() => gm.writeDirectorySaveFiles([
            { filename: "data/main", bytes: new Uint8Array([1]) },
            { filename: bad, bytes: new Uint8Array([2]) }
        ]), /Unsafe/);
        assert.equal(writes.length, 0);
    }
    const { gm, writes } = manager("ppsspp");
    for (const paths of [
        ["ULUS12345/main", "PPSSPP/PSP/SAVEDATA/ULUS12345/main"],
        ["ULUS12345/main", "ULUS12345/main/child"]
    ]) {
        assert.throws(() => gm.writeDirectorySaveFiles(paths.map(filename => ({ filename, bytes: new Uint8Array([1]) }))), /Duplicate|Conflicting/);
        assert.equal(writes.length, 0);
    }
});

test("unidentified Azahar ROMs retain legacy bundles and reject ambiguous portable imports", async () => {
    const { gm, writes, add } = manager("azahar", new Uint8Array(8));
    add("/data/saves/" + titleRoot + "/00000001/main", [1]);
    assert.ok(Object.hasOwn(unzip(gm.getSaveFile(false)), titleRoot + "/00000001/main"));
    await assert.rejects(gm.loadDirectorySaveBundle(zip({ "data/main": [2] })), /Cannot determine/);
    assert.equal(writes.length, 0);
});

test("pre-boot imports use the same portable mapping and surface save failures", async () => {
    const { gm, files } = manager("azahar");
    gm.EJS.config.externalFiles = { "/data/saves/": "/api/saves/1/content/old.srm" };
    gm.EJS.downloadFile = async (...args) => {
        assert.equal(args[5], true);
        return { data: { files: [{ filename: "data/00000001/main", bytes: new Uint8Array([1]) }] } };
    };
    gm.loadSaveFiles = () => { throw Error("core must not be refreshed before boot"); };
    await gm.loadExternalFiles();
    assert.deepEqual([...files.get("/data/saves/" + titleRoot + "/00000001/main").bytes], [1]);
    gm.FS.syncfs = (_, done) => done(Error("quota"));
    await assert.rejects(gm.loadExternalFiles(), /quota/);
    gm.EJS.downloadFile = async () => { throw Error("download failed"); };
    await assert.rejects(gm.loadExternalFiles(), /download failed/);
});

test("startup waits for portable save restoration after selecting the ROM", async () => {
    const emulator = Object.create(Emulator.prototype);
    const events = [];
    emulator.getCore = () => "azahar";
    emulator.selectRomFile = names => { emulator.fileName = names[0]; events.push("select"); };
    emulator.gameManager = {
        supportsDirectorySaveBundle: () => true,
        async loadExternalFiles() { assert.equal(emulator.fileName, "game.3ds"); events.push("restore"); }
    };
    emulator.startGame = () => events.push("boot");
    await emulator.startGameFromDownload({ files: [{ filename: "game.3ds" }] });
    assert.deepEqual(events, ["select", "restore", "boot"]);
    emulator.gameManager.loadExternalFiles = async () => { throw Error("invalid save"); };
    await assert.rejects(emulator.startGameFromDownload({ files: [{ filename: "game.3ds" }] }), /invalid save/);
    assert.equal(events.filter(event => event === "boot").length, 1);
});
