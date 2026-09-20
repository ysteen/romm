const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const { crc32, deflateRawSync } = require("node:zlib");
const systemData = require("../data/src/azahar-system-data.js");

const MII_TITLE = "0004009b00010202";
const ID0 = "00000000000000000000000000000000";

function fixture(titleId = MII_TITLE, prefix = "nand/", contentId = "00000003") {
    const app = new Uint8Array(0x1400);
    const appView = new DataView(app.buffer);
    appView.setUint32(0x100, 0x4843434e, true);
    appView.setUint32(0x104, app.length / 0x200, true);
    appView.setBigUint64(0x118, BigInt("0x" + titleId), true);
    app[0x18d] = 1;
    app[0x18f] = 4;
    appView.setUint32(0x1b0, 1, true);
    appView.setUint32(0x1b4, 9, true);
    appView.setUint32(0x200, 0x43465649, true);
    const tmd = new Uint8Array(0x140 + 0x9c4 + 0x30);
    const tmdView = new DataView(tmd.buffer);
    tmdView.setUint32(0, 0x10004, false);
    tmdView.setBigUint64(0x140 + 0x4c, BigInt("0x" + titleId), false);
    tmdView.setUint16(0x140 + 0x9e, 1, false);
    tmdView.setUint32(0x140 + 0x9c4, parseInt(contentId, 16), false);
    tmdView.setBigUint64(0x140 + 0x9c4 + 8, BigInt(app.length), false);
    const directory = prefix + ID0 + "/title/" + titleId.slice(0, 8) + "/" + titleId.slice(8) + "/content/";
    return [
        { filename: directory + contentId + ".app", bytes: app },
        { filename: directory + "00000002.tmd", bytes: tmd }
    ];
}

function rejected(entries, code) {
    assert.throws(() => systemData.prepareFiles(entries), error => {
        assert.ok(error instanceof systemData.SystemDataError);
        assert.equal(error.code, code);
        return true;
    });
}

test("maps a decrypted Mii title to Azahar's actual double-Azahar user directory", () => {
    const entries = fixture();
    const prepared = systemData.prepareFiles(entries);
    assert.equal(prepared[0].filename, systemData.NAND_ROOT + "/0004009b/00010202/content/00000003.app");
    assert.equal(prepared[1].filename, systemData.NAND_ROOT + "/0004009b/00010202/content/00000000.tmd");
    assert.equal(prepared[0].bytes, entries[0].bytes);
    assert.equal(entries[1].filename.endsWith("00000002.tmd"), true);
});

for (const prefix of ["nand/", "user/nand/", "Azahar/nand/", "Azahar/Azahar/nand/"]) {
    test("accepts the supported wrapper " + prefix, () => {
        assert.equal(systemData.prepareFiles(fixture(MII_TITLE, prefix)).length, 2);
    });
}

for (const titleId of Object.keys(systemData.TITLE_NAMES)) {
    test("accepts only the documented system title " + titleId, () => {
        assert.equal(systemData.prepareFiles(fixture(titleId))[0].titleId, titleId);
    });
}

test("accepts uppercase hex paths and an original console ID, but installs into the emulated ID", () => {
    const entries = fixture().map(entry => ({ ...entry, filename: entry.filename.replace(ID0, "a".repeat(32)).toUpperCase() }));
    assert.ok(systemData.prepareFiles(entries).every(entry => entry.filename.startsWith(systemData.NAND_ROOT)));
});

test("ignores empty directory markers without installing them", () => {
    assert.equal(systemData.prepareFiles([{ filename: "nand/", bytes: new Uint8Array() }, ...fixture()]).length, 2);
});

test("rejects archives with only directories or no entries", () => {
    rejected([], "empty");
    rejected([{ filename: "nand/", bytes: new Uint8Array() }], "empty");
    rejected(null, "empty");
});

for (const path of ["../nand/file.app", "/nand/file.app", "./nand/file.app", "C:/nand/file.app", "nand\\file.app", "nand//file.app", "nand/../file.app", "nand/%2e%2e/file.app", "nand/\u0000file.app", "", "a".repeat(513)]) {
    test("rejects unsafe archive path " + JSON.stringify(path), () => {
        rejected([{ filename: path, bytes: new Uint8Array() }, ...fixture()], "path");
    });
}

for (const path of ["CFL_DB.dat", "mii_data.app", "mii.cia", "nand/data/" + ID0 + "/extdata/00048000/f000000b/user/CFL_DB.dat", "sysdata/aes_keys.txt", "sdmc/Nintendo 3DS/save.dat", "nand/" + ID0 + "/title/00040010/00021700/content/00000000.app"]) {
    test("rejects non-allowlisted data " + path, () => {
        rejected([{ filename: path, bytes: new Uint8Array([1]) }, ...fixture()], "unsupported");
    });
}

test("rejects duplicate and case-folded archive entries", () => {
    const entries = fixture();
    rejected([...entries, entries[0]], "duplicate");
    rejected([...entries, { ...entries[0], filename: entries[0].filename.toUpperCase() }], "duplicate");
});

test("rejects aliases that would overwrite the same target title", () => {
    rejected([...fixture(), ...fixture(MII_TITLE, "user/nand/")], "duplicate");
});

test("rejects multiple metadata versions and multiple content versions", () => {
    const entries = fixture();
    rejected([...entries, { ...entries[1], filename: entries[1].filename.replace("00000002.tmd", "00000004.tmd") }], "duplicate");
    rejected([...entries, { ...entries[0], filename: entries[0].filename.replace("00000003.app", "00000004.app") }], "duplicate");
});

test("rejects non-byte data and directories with bytes", () => {
    rejected([{ ...fixture()[0], bytes: [1, 2] }], "bytes");
    rejected([{ filename: "nand/", bytes: new Uint8Array([1]) }], "path");
});

test("rejects truncated, wrong-type, executable, or out-of-bounds NCCH files", () => {
    rejected([{ ...fixture()[0], bytes: new Uint8Array(4) }], "ncch");
    for (const mutate of [
        bytes => bytes.fill(0, 0x100, 0x104),
        bytes => bytes[0x18d] = 3,
        bytes => bytes[0x180] = 1,
        bytes => bytes[0x1a4] = 1,
        bytes => bytes[0x18e] = 32,
        bytes => bytes[0x18f] |= 2,
        bytes => bytes.fill(0, 0x200, 0x204),
        bytes => new DataView(bytes.buffer).setUint32(0x104, 0xffffffff, true),
        bytes => new DataView(bytes.buffer).setUint32(0x1b0, 0, true),
        bytes => new DataView(bytes.buffer).setUint32(0x1b4, 1, true),
        bytes => new DataView(bytes.buffer).setUint32(0x1b4, 0xffffffff, true)
    ]) {
        const entries = fixture();
        mutate(entries[0].bytes);
        rejected(entries, "ncch");
    }
});

test("rejects encrypted NCCH and title-ID mismatches", () => {
    const encrypted = fixture();
    encrypted[0].bytes[0x18f] = 0;
    rejected(encrypted, "encrypted");
    for (const index of [0, 1]) {
        const entries = fixture();
        const offset = index === 0 ? 0x118 : 0x140 + 0x4c;
        entries[index].bytes[offset] ^= 1;
        rejected(entries, "title");
    }
});

test("rejects invalid or multi-content metadata", () => {
    rejected([fixture()[0], { ...fixture()[1], bytes: new Uint8Array(3) }], "tmd");
    for (const mutate of [
        bytes => bytes.fill(0, 0, 4),
        bytes => new DataView(bytes.buffer).setUint16(0x140 + 0x9e, 2, false),
        bytes => new DataView(bytes.buffer).setUint16(0x140 + 0x9c4 + 4, 1, false)
    ]) {
        const entries = fixture();
        mutate(entries[1].bytes);
        rejected(entries, "tmd");
    }
});

test("rejects missing or mismatched metadata/content pairs", () => {
    rejected([fixture()[0]], "incomplete");
    rejected([fixture()[1]], "incomplete");
    const mismatchId = fixture();
    mismatchId[1].bytes[0x140 + 0x9c4 + 3] = 4;
    rejected(mismatchId, "incomplete");
    const mismatchSize = fixture();
    new DataView(mismatchSize[1].bytes.buffer).setBigUint64(0x140 + 0x9c4 + 8, 512n, false);
    rejected(mismatchSize, "incomplete");
});

test("validates an entire batch without mutating inputs on failure", () => {
    const entries = fixture();
    const before = entries.map(entry => ({ ...entry, bytes: entry.bytes.slice() }));
    rejected([...entries, { filename: "save.dat", bytes: new Uint8Array() }], "unsupported");
    assert.deepEqual(entries, before);
});

test("limits entry count, per-file bytes, total expanded bytes, and metadata size", () => {
    rejected(Array.from({ length: systemData.MAX_ENTRIES + 1 }, () => fixture()[0]), "size");
    rejected([{ ...fixture()[0], bytes: new Uint8Array(systemData.MAX_FILE_BYTES + 1) }], "size");
    const entries = Object.keys(systemData.TITLE_NAMES).slice(0, 3).flatMap(titleId => {
        const pair = fixture(titleId);
        const app = new Uint8Array(systemData.MAX_FILE_BYTES);
        app.set(pair[0].bytes);
        pair[0].bytes = app;
        return pair;
    });
    rejected(entries, "size");
    const invalidSize = fixture();
    new DataView(invalidSize[1].bytes.buffer).setBigUint64(0x140 + 0x9c4 + 8, 0xffffffffffffffffn, false);
    rejected(invalidSize, "size");
});

test("exports a frozen browser global without requiring CommonJS", () => {
    const scope = {};
    runInNewContext(readFileSync(join(__dirname, "../data/src/azahar-system-data.js"), "utf8"), scope);
    assert.equal(typeof scope.EJS_AzaharSystemData.prepareFiles, "function");
    assert.ok(Object.isFrozen(scope.EJS_AzaharSystemData));
    assert.ok(Object.isFrozen(scope.EJS_AzaharSystemData.TITLE_NAMES));
});

function zipFixture(entries = fixture(), descriptor = false, method = 0) {
    const localParts = [];
    const centralParts = [];
    const localOffsets = [];
    const centralOffsets = [];
    let localSize = 0;
    let centralSize = 0;
    for (const entry of entries) {
        const name = new TextEncoder().encode(entry.filename);
        const packed = method === 8 ? deflateRawSync(entry.bytes) : entry.bytes;
        const checksum = crc32(entry.bytes);
        const local = new Uint8Array(30 + name.length + packed.length + (descriptor ? 16 : 0));
        const localView = new DataView(local.buffer);
        localView.setUint32(0, 0x04034b50, true);
        localView.setUint16(6, descriptor ? 8 : 0, true);
        localView.setUint16(8, method, true);
        localView.setUint32(14, descriptor ? 0 : checksum, true);
        localView.setUint32(18, descriptor ? 0 : packed.length, true);
        localView.setUint32(22, descriptor ? 0 : entry.bytes.length, true);
        localView.setUint16(26, name.length, true);
        local.set(name, 30);
        local.set(packed, 30 + name.length);
        if (descriptor) {
            const position = 30 + name.length + packed.length;
            localView.setUint32(position, 0x08074b50, true);
            localView.setUint32(position + 4, checksum, true);
            localView.setUint32(position + 8, packed.length, true);
            localView.setUint32(position + 12, entry.bytes.length, true);
        }
        const central = new Uint8Array(46 + name.length);
        const centralView = new DataView(central.buffer);
        centralView.setUint32(0, 0x02014b50, true);
        centralView.setUint16(8, descriptor ? 8 : 0, true);
        centralView.setUint16(10, method, true);
        centralView.setUint32(16, checksum, true);
        centralView.setUint32(20, packed.length, true);
        centralView.setUint32(24, entry.bytes.length, true);
        centralView.setUint16(28, name.length, true);
        centralView.setUint32(42, localSize, true);
        central.set(name, 46);
        localParts.push(local);
        centralParts.push(central);
        localOffsets.push(localSize);
        centralOffsets.push(centralSize);
        localSize += local.length;
        centralSize += central.length;
    }
    const zip = new Uint8Array(localSize + centralSize + 22);
    let position = 0;
    for (const part of [...localParts, ...centralParts]) {
        zip.set(part, position);
        position += part.length;
    }
    const view = new DataView(zip.buffer);
    view.setUint32(position, 0x06054b50, true);
    view.setUint16(position + 8, entries.length, true);
    view.setUint16(position + 10, entries.length, true);
    view.setUint32(position + 12, centralSize, true);
    view.setUint32(position + 16, localSize, true);
    return { zip, localOffsets, centralOffsets: centralOffsets.map(offset => offset + localSize), endOffset: position };
}

function rejectedZip(bytes, code) {
    assert.throws(() => systemData.assertZip(bytes), error => {
        assert.ok(error instanceof systemData.SystemDataError);
        assert.equal(error.code, code);
        return true;
    });
}

test("preflights stored ZIP entries and returns bounded expanded sizes", () => {
    const entries = fixture();
    const result = systemData.assertZip(zipFixture(entries).zip);
    assert.equal(result.totalBytes, entries.reduce((size, entry) => size + entry.bytes.length, 0));
    assert.deepEqual(result.files.map(({ filename, size }) => ({ filename, size })), entries.map(entry => ({ filename: entry.filename, size: entry.bytes.length })));
});

test("preflights standard ZIP data descriptors", () => {
    assert.equal(systemData.assertZip(zipFixture(fixture(), true).zip).files.length, 2);
});

test("preflights raw-deflate ZIP metadata", () => {
    const data = zipFixture();
    const view = new DataView(data.zip.buffer);
    for (const offset of data.localOffsets) view.setUint16(offset + 8, 8, true);
    for (const offset of data.centralOffsets) view.setUint16(offset + 10, 8, true);
    assert.equal(systemData.assertZip(data.zip).files.length, 2);
});

test("preflight rejects truncated, non-ZIP, and multi-disk archives", () => {
    rejectedZip(new Uint8Array(8), "zip");
    rejectedZip(new Uint8Array(50), "zip");
    rejectedZip(zipFixture().zip.subarray(0, -1), "zip");
    const data = zipFixture();
    new DataView(data.zip.buffer).setUint16(data.endOffset + 4, 1, true);
    rejectedZip(data.zip, "zip");
});

test("preflight rejects central-directory expansion bombs before extraction", () => {
    const data = zipFixture();
    const view = new DataView(data.zip.buffer);
    view.setUint16(data.centralOffsets[0] + 10, 8, true);
    view.setUint32(data.centralOffsets[0] + 24, systemData.MAX_FILE_BYTES + 1, true);
    rejectedZip(data.zip, "size");
});

test("preflight rejects encrypted files and symlinks", () => {
    for (const mutate of [
        (view, offset) => view.setUint16(offset + 8, 1, true),
        (view, offset) => view.setUint16(offset + 8, 0x40, true),
        (view, offset) => view.setUint32(offset + 38, 0xa0000000, true)
    ]) {
        const data = zipFixture();
        mutate(new DataView(data.zip.buffer), data.centralOffsets[0]);
        rejectedZip(data.zip, "zip");
    }
});

test("preflight rejects unsafe, duplicate, and non-allowlisted names before extraction", () => {
    rejectedZip(zipFixture([{ filename: "../file.app", bytes: new Uint8Array() }]).zip, "path");
    rejectedZip(zipFixture([{ filename: "sdmc/save.dat", bytes: new Uint8Array() }]).zip, "unsupported");
    rejectedZip(zipFixture([...fixture(), fixture()[0]]).zip, "duplicate");
});

test("preflight rejects mismatched local paths, methods, sizes, offsets, and descriptors", () => {
    for (const mutate of [
        (view, data) => view.setUint8(data.localOffsets[0] + 30, 0x78),
        (view, data) => view.setUint16(data.localOffsets[0] + 8, 8, true),
        (view, data) => view.setUint32(data.localOffsets[0] + 22, 1, true),
        (view, data) => view.setUint32(data.centralOffsets[0] + 42, data.endOffset, true),
        (view, data) => view.setUint32(data.endOffset + 12, 0, true)
    ]) {
        const data = zipFixture();
        mutate(new DataView(data.zip.buffer), data);
        rejectedZip(data.zip, "zip");
    }
    const data = zipFixture(fixture(), true);
    data.zip[data.localOffsets[1] - 1] ^= 1;
    rejectedZip(data.zip, "zip");
});

test("preflight accepts a typed-array view without reading adjacent memory", () => {
    const { zip } = zipFixture();
    const padded = new Uint8Array(zip.length + 20);
    padded.set(zip, 10);
    assert.equal(systemData.assertZip(padded.subarray(10, -10)).files.length, 2);
});

for (const method of [0, 8]) {
    for (const descriptor of [false, true]) {
        test("extracts bounded system-data ZIP with method " + method + " and descriptor " + descriptor, async () => {
            const entries = fixture();
            const output = await systemData.extractZip(zipFixture(entries, descriptor, method).zip);
            assert.deepEqual(output, entries);
            assert.equal(systemData.prepareFiles(output).length, 2);
        });
    }
}

test("rejects stored CRC32 corruption even when headers agree", async () => {
    const data = zipFixture();
    const manifest = systemData.assertZip(data.zip);
    data.zip[manifest.files[0].dataOffset] ^= 1;
    await assert.rejects(systemData.extractZip(data.zip), { code: "zip" });
});

test("rejects deflate CRC32 corruption and truncated streams", async () => {
    const data = zipFixture(fixture(), false, 8);
    const view = new DataView(data.zip.buffer);
    view.setUint32(data.localOffsets[0] + 14, 0, true);
    view.setUint32(data.centralOffsets[0] + 16, 0, true);
    await assert.rejects(systemData.extractZip(data.zip), { code: "zip" });
    const broken = zipFixture(fixture(), false, 8);
    const entry = systemData.assertZip(broken.zip).files[0];
    broken.zip.fill(255, entry.dataOffset, entry.dataOffset + entry.packedSize);
    await assert.rejects(systemData.extractZip(broken.zip), { code: "zip" });
});

test("caps actual deflate expansion even when all ZIP headers lie consistently", async () => {
    const data = zipFixture(fixture(), false, 8);
    const view = new DataView(data.zip.buffer);
    view.setUint32(data.localOffsets[0] + 22, 1, true);
    view.setUint32(data.centralOffsets[0] + 24, 1, true);
    await assert.rejects(systemData.extractZip(data.zip), { code: "size" });
});

test("rejects a deflate output shorter than its declared size", async () => {
    const data = zipFixture(fixture(), false, 8);
    const view = new DataView(data.zip.buffer);
    view.setUint32(data.localOffsets[0] + 22, 0x1401, true);
    view.setUint32(data.centralOffsets[0] + 24, 0x1401, true);
    await assert.rejects(systemData.extractZip(data.zip), { code: "zip" });
});

test("reports unsupported raw-deflate streams without affecting stored ZIPs", async () => {
    const scope = { Uint8Array, DataView, Uint32Array };
    runInNewContext(readFileSync(join(__dirname, "../data/src/azahar-system-data.js"), "utf8"), scope);
    const api = scope.EJS_AzaharSystemData;
    await assert.rejects(api.extractZip(zipFixture(fixture(), false, 8).zip), { code: "decompression" });
    assert.equal((await api.extractZip(zipFixture().zip)).length, 2);
});
