const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

function harness() {
    const calls = [];
    const timers = [];
    const source = readFileSync(require.resolve("../data/src/GameManager.js"), "utf8")
        .replace(/^export .*$/gm, "");
    const Manager = runInNewContext(source + "\nEJS_GameManager", {
        Date, console,
        setTimeout: fn => timers.push(fn),
        clearInterval: () => calls.push("clearInterval"),
    });
    class TestManager extends Manager {
        writeFile() {}
        getRetroArchCfg() { return ""; }
        writeConfigFile() {}
        initShaders() {}
        setupPreLoadSettings() {}
        usesSaveDirectory() { return false; }
        saveSaveFiles() { calls.push("save"); }
        toggleMainLoop(value) { calls.push(["loop", value]); }
    }
    let exit;
    new TestManager({
        FS: { unmount: path => calls.push(["unmount", path]) },
        cwrap: name => () => calls.push(name),
        abort: () => calls.push("abort"),
    }, {
        saveSaveInterval: 1,
        on: (_event, handler) => { exit = handler; },
    });
    return { calls, timers, exit };
}

test("link switching flushes and releases the old core without restarting it", () => {
    const h = harness();
    h.exit({ restart: false });
    assert.deepEqual(h.calls, ["save", "clearInterval", ["loop", 0], ["unmount", "/data/saves"]]);
    h.timers.forEach(fn => fn());
    assert.equal(h.calls.at(-1), "abort");
});

test("ordinary exits retain the restart needed by other single-save cores", () => {
    const h = harness();
    h.exit();
    assert.deepEqual(h.calls.slice(0, 3), ["save", "system_restart", "save"]);
});

test("unmount and unload can both exit without restarting or unmounting twice", () => {
    const h = harness();
    h.exit({ restart: false });
    const first = [...h.calls];
    h.exit();
    assert.deepEqual(h.calls, first);
    assert.equal(h.timers.length, 1);
});
