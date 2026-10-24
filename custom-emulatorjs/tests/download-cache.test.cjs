const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const read = file => readFileSync(require.resolve("../data/" + file), "utf8");
function load(file, expression, context = {}) {
    const source = read("src/" + file).replace(/^import .*;$/gm, "").replace(/^export /gm, "");
    return runInNewContext(source + "\n" + expression, {
        Uint8Array, ArrayBuffer, TextEncoder, URL, Blob, AbortController, Date,
        performance, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} },
        ...context
    });
}

function harness(options = {}) {
    const stores = new Map();
    const requests = [];
    let extractions = 0;
    class MemoryStorage {
        constructor(dbName, storeName) {
            const name = dbName + "/" + storeName;
            if (!stores.has(name)) stores.set(name, new Map());
            this.records = stores.get(name);
        }
        async get(key, index) {
            const value = index ? [...this.records.values()].find(item => item[index] === key) : this.records.get(key);
            return structuredClone(value);
        }
        async put(key, value) { this.records.set(key, structuredClone(value)); }
        async remove(key) { this.records.delete(key); }
        async getAll() { return structuredClone([...this.records.values()]); }
        async getKeys() { return [...this.records.keys()]; }
    }
    const classes = load("cache.js", "({ EJS_Cache, EJS_Download, EJS_CacheItem, EJS_FileItem })", {
        EJS_CacheStorage: options.storage || MemoryStorage,
        simpleHash: load("utils.js", "simpleHash"),
        EJS_COMPRESSION: class {
            async decompress(_data, _progress, onFile) {
                extractions++;
                onFile("core.wasm", new Uint8Array([0, 97, 115, 109]));
                onFile("core.js", new Uint8Array([1, 2]));
            }
        },
        fetch: async (url, init) => {
            requests.push({ url, ...init });
            return options.fetch ? options.fetch(url, init) : new Response(new Uint8Array([7, 8, 9]));
        }
    });
    const cache = () => new classes.EJS_Cache(true, "test-downloads", 4096, 7200);
    const download = (storage, url = "https://example.test/game.zip", settings = {}) =>
        new classes.EJS_Download(storage).downloadFile(
            url, settings.core ? "Core" : "ROM", "GET", {}, null, null, null,
            30000, "arraybuffer", !!settings.core, !!settings.dontCache, !settings.core
        );
    return { ...classes, cache, download, requests, stores, extractions: () => extractions };
}

test("DOSBox download caching uses normal defaults and respects explicit settings", () => {
    const setup = load("setup.js", "EJS_SETUP");
    const loader = read("loader.js").split("async function prepareLanguage")[0];
    for (const core of ["dos", "dosbox_pure", "snes9x"]) {
        for (const custom of [undefined, { enabled: false, cacheMaxSizeMB: 256 }]) {
            const config = runInNewContext(loader + "\nconfig", {
                URL, window: { EJS_core: core, EJS_CacheLimit: 1024 * 1024 * 1024, EJS_cacheConfig: custom },
                document: { baseURI: "https://example.test/", currentScript: { src: "https://example.test/data/loader.js" } }
            });
            new setup({ config }).cacheDefaults();
            assert.equal(config.cacheConfig.enabled, custom ? false : true);
            assert.equal(config.cacheConfig.cacheMaxSizeMB, custom ? 256 : 1024);
        }
    }
});

test("a new launch reuses the downloaded and extracted core; a new build downloads again", async () => {
    const h = harness();
    const first = await h.download(h.cache(), "https://example.test/core.data?v=build-1", { core: true });
    const second = await h.download(h.cache(), "https://example.test/core.data?v=build-1", { core: true });
    assert.equal(second.source, "cache");
    assert.deepEqual(second.files[0].bytes, first.files[0].bytes);
    assert.equal(h.requests.length, 1);
    assert.equal(h.extractions(), 1);
    await h.download(h.cache(), "https://example.test/core.data?v=build-2", { core: true });
    assert.equal(h.requests.length, 2);
    assert.equal(h.extractions(), 2);
});

test("DOS packages stay compressed and a new launch reuses their bytes", async () => {
    const h = harness();
    const first = await h.download(h.cache());
    const second = await h.download(h.cache());
    assert.equal(second.source, "cache");
    assert.deepEqual(second.files[0].bytes, first.files[0].bytes);
    assert.equal(h.requests.length, 1);
    assert.equal(h.extractions(), 0);
});

test("reports and save bundles bypass existing download cache entries", async () => {
    const h = harness();
    const cache = h.cache();
    cache.get = cache.put = () => { throw Error("must bypass cache"); };
    await h.download(cache, "https://example.test/save.zip", { dontCache: true });
    assert.equal(cache.enabled, true);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].cache, "no-store");
});

test("cache read and write errors still return downloaded bytes", async () => {
    for (const method of ["get", "put"]) {
        const h = harness();
        const cache = h.cache();
        cache[method] = async () => { throw new DOMException("Storage full", "QuotaExceededError"); };
        const downloaded = await h.download(cache);
        assert.deepEqual(downloaded.files[0].bytes, new Uint8Array([7, 8, 9]));
        assert.equal(cache.enabled, false);
        await h.download(cache);
        assert.equal(h.requests.length, 2);
    }
});

test("cache hits do not wait for cleanup or access-time writes", async () => {
    const h = harness();
    const first = await h.download(h.cache());
    const cache = h.cache();
    await cache.createCacheDatabase();
    cache.cleanup = () => { throw Error("cleanup must not block a read"); };
    let metadata;
    cache.storage.put = (_key, item) => { metadata = item; return new Promise(() => {}); };
    const second = await h.download(cache);
    assert.deepEqual(second.files[0].bytes, first.files[0].bytes);
    assert.equal(metadata.files, undefined);
    assert.equal(h.requests.length, 1);
});

test("a missing payload chunk is a cache miss and is repaired by downloading", async () => {
    const h = harness();
    const first = await h.download(h.cache());
    h.stores.get("test-downloads/blobs").delete(first.key + "__blob__0");
    await h.download(h.cache());
    assert.equal(h.requests.length, 2);
    assert.equal((await h.download(h.cache())).source, "cache");
    assert.equal(h.requests.length, 2);
});

test("failed payload writes do not publish cache metadata", async () => {
    const h = harness();
    const cache = h.cache();
    await cache.createCacheDatabase();
    cache.blobStorage.put = async () => { throw Error("disk full"); };
    await h.download(cache);
    assert.equal(h.stores.get("test-downloads/cache").size, 0);
});

test("an oversized ROM does not evict already cached cores", async () => {
    const h = harness();
    const cache = h.cache();
    const core = await h.download(cache);
    cache.maxSizeMB = 4 / 1024 / 1024;
    const oversized = new h.EJS_CacheItem("large", [new h.EJS_FileItem("large.zip", new Uint8Array(5))], Date.now());
    await cache.put(oversized);
    assert.ok(await cache.get(core.key));
    assert.equal(await cache.get("large"), null);
});

test("expired entries without a usable validator are downloaded and replaced", async () => {
    let value = 1;
    const h = harness({ fetch: (_url, init) => init.method === "HEAD"
        ? new Response(null, { status: 405 })
        : new Response(new Uint8Array([value++]), { headers: { "Cache-Control": "no-cache" } }) });
    await h.download(h.cache());
    const latest = await h.download(h.cache());
    assert.deepEqual(latest.files[0].bytes, new Uint8Array([2]));
    assert.equal(h.stores.get("test-downloads/cache").size, 1);
    assert.equal(h.requests.filter(request => request.method === "GET").length, 2);
});

test("server no-store responses are never persisted", async () => {
    const h = harness({ fetch: () => new Response(new Uint8Array([1]), { headers: { "Cache-Control": "no-store" } }) });
    await h.download(h.cache());
    await h.download(h.cache());
    assert.equal(h.requests.length, 2);
    assert.equal(h.stores.get("test-downloads/cache").size, 0);
});

function storageWithOpen(open, context = {}) {
    return load("cache-storage.js", "EJS_CacheStorage", { window: { indexedDB: { open } }, ...context });
}

test("a stalled IndexedDB open times out and subsequent downloads skip storage", async () => {
    let opens = 0;
    const Storage = storageWithOpen(() => { opens++; return {}; }, {
        setTimeout: callback => setTimeout(callback, 10)
    });
    const h = harness({ storage: Storage });
    const cache = h.cache();
    await h.download(cache);
    await h.download(cache);
    assert.equal(opens, 1);
    assert.equal(h.requests.length, 2);
    assert.equal(cache.enabled, false);
});

test("blocked opens reject and any late connection is closed", async () => {
    const open = {};
    const Storage = storageWithOpen(() => open);
    const pending = new Storage("test", "cache").get("key");
    open.onblocked();
    await assert.rejects(pending, /blocked/);
    let closes = 0;
    open.result = { close() { closes++; } };
    open.onsuccess();
    assert.equal(closes, 1);
});

test("cache reads use readonly transactions and writes resolve only on commit", async () => {
    for (const method of ["get", "put"]) {
        const open = {};
        const transaction = { objectStore: () => ({ get: () => ({ result: 42 }), put: () => ({ result: "key" }) }) };
        let closes = 0;
        open.result = {
            close() { closes++; },
            transaction(_store, mode) { assert.equal(mode, method === "get" ? "readonly" : "readwrite"); return transaction; }
        };
        const Storage = storageWithOpen(() => open);
        let completed = false;
        const pending = new Storage("test", "cache")[method]("key", method === "put" ? 42 : null)
            .then(value => { completed = true; return value; });
        open.onsuccess();
        await Promise.resolve();
        assert.equal(completed, false);
        transaction.oncomplete();
        assert.equal(await pending, method === "get" ? 42 : "key");
        assert.ok(closes > 0);
    }
});

test("aborted cache transactions reject instead of reporting a saved entry", async () => {
    const open = {};
    const transaction = { objectStore: () => ({ put: () => ({}) }), error: new Error("quota") };
    open.result = { close() {}, transaction: () => transaction };
    const Storage = storageWithOpen(() => open);
    const pending = new Storage("test", "cache").put("key", new Uint8Array([1]));
    open.onsuccess();
    transaction.onabort();
    await assert.rejects(pending, /quota/);
});
