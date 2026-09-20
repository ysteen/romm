(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.EJS_AzaharSystemData = api;
    }
})(globalThis, function () {
    "use strict";

    const NAND_ROOT = "/data/saves/Azahar/Azahar/nand/00000000000000000000000000000000/title";
    const MAX_FILE_BYTES = 64 * 1024 * 1024;
    const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
    const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
    const MAX_ENTRIES = 128;
    const TITLE_NAMES = Object.freeze({
        "0004009b00010202": "Mii face data",
        "0004009b00014002": "JPN/EUR/USA shared font",
        "0004009b00014102": "CHN shared font",
        "0004009b00014202": "KOR shared font",
        "0004009b00014302": "TWN shared font"
    });

    class SystemDataError extends Error {
        constructor(code, message) {
            super(message);
            this.name = "AzaharSystemDataError";
            this.code = code;
        }
    }

    function fail(code, message) {
        throw new SystemDataError(code, message);
    }

    function validatePath(filename) {
        if (typeof filename !== "string" || !filename.length || filename.length > 512 ||
            filename.startsWith("/") || /[\\:\x00-\x1f\x7f%]/u.test(filename)) {
            fail("path", "System-data archives must contain safe relative paths.");
        }
        const path = filename.endsWith("/") ? filename.slice(0, -1) : filename;
        if (path.split("/").some(part => !part || part === "." || part === "..")) {
            fail("path", "System-data archives cannot contain relative traversal paths.");
        }
        return path.toLowerCase();
    }

    function parseTitlePath(path) {
        const match = /^(?:(?:user|azahar(?:\/azahar)?)\/)?nand\/([0-9a-f]{32})\/title\/(0004009b)\/(00010202|00014[0-3]02)\/content\/([0-9a-f]{8})\.(app|tmd)$/u.exec(path);
        if (!match) {
            fail("unsupported", "Only Mii face and shared-font NAND title files are supported. Do not include saves, keys, CIA files, or a complete NAND dump.");
        }
        return {
            titleId: match[2] + match[3],
            high: match[2],
            low: match[3],
            contentId: match[4],
            kind: match[5]
        };
    }

    function checkExtraFields(view, offset, length) {
        const end = offset + length;
        while (offset < end) {
            if (offset + 4 > end) fail("zip", "The ZIP extra fields are truncated.");
            const id = view.getUint16(offset, true);
            const size = view.getUint16(offset + 2, true);
            if (id === 1 || id === 0x7075 || offset + 4 + size > end) {
                fail("zip", "ZIP64 and alternate Unicode ZIP paths are unsupported.");
            }
            offset += 4 + size;
        }
    }

    // Run before extraction: compressed limits alone cannot bound ZIP expansion.
    function assertZip(bytes) {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) {
            fail("zip", "Expected a system-data ZIP archive.");
        }
        if (bytes.byteLength > MAX_ARCHIVE_BYTES) fail("size", "The compressed system-data archive is too large.");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let endOffset = -1;
        for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 22 - 65535); offset--) {
            if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength) {
                endOffset = offset;
                break;
            }
        }
        if (endOffset === -1) fail("zip", "The ZIP archive is incomplete or has no end record.");
        const count = view.getUint16(endOffset + 10, true);
        const directorySize = view.getUint32(endOffset + 12, true);
        const directoryOffset = view.getUint32(endOffset + 16, true);
        if (!count || count > MAX_ENTRIES) fail("size", "The ZIP archive has an unsupported entry count.");
        if (view.getUint16(endOffset + 4, true) !== 0 || view.getUint16(endOffset + 6, true) !== 0 ||
            view.getUint16(endOffset + 8, true) !== count || directoryOffset + directorySize !== endOffset) {
            fail("zip", "Multipart, ZIP64, and inconsistent ZIP archives are unsupported.");
        }
        const seen = new Set();
        const ranges = [];
        const files = [];
        let totalBytes = 0;
        let offset = directoryOffset;
        for (let index = 0; index < count; index++) {
            if (offset + 46 > endOffset || view.getUint32(offset, true) !== 0x02014b50) {
                fail("zip", "The ZIP central directory is incomplete.");
            }
            const flags = view.getUint16(offset + 8, true);
            const method = view.getUint16(offset + 10, true);
            const checksum = view.getUint32(offset + 16, true);
            const packedSize = view.getUint32(offset + 20, true);
            const size = view.getUint32(offset + 24, true);
            const nameLength = view.getUint16(offset + 28, true);
            const extraLength = view.getUint16(offset + 30, true);
            const commentLength = view.getUint16(offset + 32, true);
            const localOffset = view.getUint32(offset + 42, true);
            const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
            const unixType = (view.getUint32(offset + 38, true) >>> 16) & 0xf000;
            if (nextOffset > endOffset || !nameLength || nameLength > 512 ||
                view.getUint16(offset + 34, true) !== 0 || (flags & ~0x080e) !== 0 ||
                (method !== 0 && method !== 8) || (method === 0 && packedSize !== size) ||
                (unixType !== 0 && unixType !== 0x8000 && unixType !== 0x4000)) {
                fail("zip", "Unsupported ZIP compression, encrypted files, links, or metadata.");
            }
            if (size > MAX_FILE_BYTES || packedSize > MAX_ARCHIVE_BYTES || (totalBytes += size) > MAX_TOTAL_BYTES) {
                fail("size", "The expanded system-data archive exceeds the supported size limit.");
            }
            const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
            if (nameBytes.some(byte => byte > 0x7f)) fail("path", "System-data ZIP paths must use ASCII names.");
            const filename = String.fromCharCode(...nameBytes);
            const path = validatePath(filename);
            if (seen.has(path)) fail("duplicate", "The ZIP archive contains duplicate paths.");
            seen.add(path);
            if (!filename.endsWith("/")) {
                parseTitlePath(path);
            } else if (size !== 0) {
                fail("path", "ZIP directories cannot contain file data.");
            }
            checkExtraFields(view, offset + 46 + nameLength, extraLength);
            if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== 0x04034b50 ||
                view.getUint16(localOffset + 6, true) !== flags || view.getUint16(localOffset + 8, true) !== method ||
                view.getUint16(localOffset + 26, true) !== nameLength) {
                fail("zip", "The ZIP local header does not match its central directory.");
            }
            const localExtraLength = view.getUint16(localOffset + 28, true);
            const dataOffset = localOffset + 30 + nameLength + localExtraLength;
            let dataEnd = dataOffset + packedSize;
            if (dataEnd > directoryOffset || nameBytes.some((byte, position) => bytes[localOffset + 30 + position] !== byte)) {
                fail("zip", "The ZIP payload or filename does not match its central directory.");
            }
            checkExtraFields(view, localOffset + 30 + nameLength, localExtraLength);
            if (flags & 8) {
                if (dataEnd + 12 > directoryOffset) fail("zip", "The ZIP data descriptor is truncated.");
                const descriptorOffset = dataEnd + (view.getUint32(dataEnd, true) === 0x08074b50 ? 4 : 0);
                dataEnd = descriptorOffset + 12;
                if (dataEnd > directoryOffset || view.getUint32(descriptorOffset, true) !== checksum ||
                    view.getUint32(descriptorOffset + 4, true) !== packedSize || view.getUint32(descriptorOffset + 8, true) !== size) {
                    fail("zip", "The ZIP data descriptor is inconsistent.");
                }
            } else if (view.getUint32(localOffset + 14, true) !== checksum ||
                view.getUint32(localOffset + 18, true) !== packedSize || view.getUint32(localOffset + 22, true) !== size) {
                fail("zip", "The ZIP local content size or checksum is inconsistent.");
            }
            ranges.push([localOffset, dataEnd]);
            files.push(Object.freeze({ filename, size, packedSize, dataOffset, method, checksum }));
            offset = nextOffset;
        }
        if (offset !== endOffset) fail("zip", "The ZIP central-directory length is inconsistent.");
        ranges.sort((first, second) => first[0] - second[0]);
        for (let index = 1; index < ranges.length; index++) {
            if (ranges[index][0] < ranges[index - 1][1]) fail("zip", "Overlapping ZIP entries are unsupported.");
        }
        return Object.freeze({ totalBytes, files });
    }

    const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
        for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
        return value >>> 0;
    });

    function updateCrc(crc, bytes) {
        for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        return crc;
    }

    async function inflateEntry(bytes, entry) {
        let decompressor;
        try {
            decompressor = new DecompressionStream("deflate-raw");
        } catch {
            fail("decompression", "This browser cannot decompress raw-deflate ZIP files. Use a current browser or a ZIP with stored entries.");
        }
        let offset = 0;
        const input = new ReadableStream({
            pull(controller) {
                if (offset >= bytes.byteLength) {
                    controller.close();
                    return;
                }
                const end = Math.min(offset + 16384, bytes.byteLength);
                controller.enqueue(bytes.subarray(offset, end));
                offset = end;
            }
        });
        const reader = input.pipeThrough(decompressor).getReader();
        const output = new Uint8Array(entry.size);
        let written = 0;
        let crc = 0xffffffff;
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (written + value.byteLength > entry.size || written + value.byteLength > MAX_FILE_BYTES) {
                    fail("size", "The ZIP stream expands beyond its declared size.");
                }
                output.set(value, written);
                written += value.byteLength;
                crc = updateCrc(crc, value);
            }
        } catch (error) {
            await reader.cancel().catch(() => {});
            if (error instanceof SystemDataError) throw error;
            fail("zip", "The ZIP deflate stream is invalid or incomplete.");
        } finally {
            reader.releaseLock();
        }
        if (written !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.checksum) {
            fail("zip", "The extracted ZIP size or CRC32 checksum does not match its directory.");
        }
        return output;
    }

    async function extractZip(bytes) {
        const manifest = assertZip(bytes);
        const files = [];
        for (const entry of manifest.files) {
            const packed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.packedSize);
            let content;
            if (entry.method === 0) {
                if (((updateCrc(0xffffffff, packed) ^ 0xffffffff) >>> 0) !== entry.checksum) {
                    fail("zip", "The stored ZIP entry has an invalid CRC32 checksum.");
                }
                content = packed;
            } else {
                content = await inflateEntry(packed, entry);
            }
            files.push({ filename: entry.filename, bytes: content });
        }
        return files;
    }

    function readTitleId(view, offset, littleEndian) {
        return view.getBigUint64(offset, littleEndian).toString(16).padStart(16, "0");
    }

    function checkNcch(bytes, titleId) {
        if (bytes.byteLength < 0x200) fail("ncch", "The system-data NCCH header is truncated.");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(0x100, true) !== 0x4843434e) {
            fail("ncch", "Expected a decrypted NCCH .app file, not a CIA, raw NAND, or RomFS file.");
        }
        if (readTitleId(view, 0x118, true) !== titleId) {
            fail("title", "The NCCH title ID does not match its allowlisted NAND directory.");
        }
        if (!(bytes[0x18f] & 4)) {
            fail("encrypted", "Encrypted system data is unsupported. Export decrypted system titles from your own console.");
        }
        const contentSize = view.getUint32(0x104, true) * 0x200;
        const romfsOffset = view.getUint32(0x1b0, true) * 0x200;
        const romfsSize = view.getUint32(0x1b4, true) * 0x200;
        if ((bytes[0x18d] & 2) || view.getUint32(0x180, true) !== 0 ||
            view.getUint32(0x1a4, true) !== 0 || bytes[0x18e] !== 0 ||
            (bytes[0x18f] & 2) || contentSize < 0x200 || contentSize > bytes.byteLength ||
            romfsOffset < 0x200 || romfsSize <= 0x1000 || romfsOffset + romfsSize > contentSize) {
            fail("ncch", "Expected a non-executable system-data archive with a complete RomFS.");
        }
        if (view.getUint32(romfsOffset, true) !== 0x43465649) {
            fail("ncch", "The system-data RomFS is missing its IVFC header.");
        }
    }

    function checkTmd(bytes, titleId) {
        if (bytes.byteLength < 4) fail("tmd", "The title metadata is truncated.");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const bodyOffsets = {
            0x10000: 0x240, 0x10001: 0x140, 0x10002: 0x40,
            0x10003: 0x240, 0x10004: 0x140, 0x10005: 0x40
        };
        const bodyOffset = bodyOffsets[view.getUint32(0, false)];
        if (bodyOffset === undefined || bytes.byteLength < bodyOffset + 0x9c4 + 0x30) {
            fail("tmd", "The title metadata has an unsupported signature type or incomplete body.");
        }
        if (readTitleId(view, bodyOffset + 0x4c, false) !== titleId) {
            fail("title", "The title metadata ID does not match its allowlisted NAND directory.");
        }
        if (view.getUint16(bodyOffset + 0x9e, false) !== 1) {
            fail("tmd", "System-data imports require exactly one content record per title.");
        }
        const chunkOffset = bodyOffset + 0x9c4;
        if (view.getUint16(chunkOffset + 4, false) !== 0) {
            fail("tmd", "The system-data title must contain content index zero.");
        }
        const contentSize = view.getBigUint64(chunkOffset + 8, false);
        if (contentSize < 0x200n || contentSize > BigInt(MAX_FILE_BYTES)) {
            fail("size", "The title metadata declares an unsupported content size.");
        }
        return {
            contentId: view.getUint32(chunkOffset, false).toString(16).padStart(8, "0"),
            contentSize: Number(contentSize)
        };
    }

    // Validation finishes before the caller writes anything to the emulated filesystem.
    function prepareFiles(entries) {
        if (!Array.isArray(entries) || entries.length === 0) {
            fail("empty", "The system-data archive contains no files.");
        }
        if (entries.length > MAX_ENTRIES) fail("size", "The system-data archive contains too many entries.");
        const seen = new Set();
        const titles = new Map();
        let totalBytes = 0;
        for (const entry of entries) {
            const path = validatePath(entry?.filename);
            if (seen.has(path)) fail("duplicate", "The system-data archive contains duplicate paths.");
            seen.add(path);
            if (!(entry.bytes instanceof Uint8Array)) {
                fail("bytes", "System-data file contents must be byte arrays.");
            }
            totalBytes += entry.bytes.byteLength;
            if (entry.bytes.byteLength > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
                fail("size", "The system-data archive exceeds the supported size limit.");
            }
            if (entry.filename.endsWith("/")) {
                if (entry.bytes.byteLength !== 0) fail("path", "Archive directories cannot contain file data.");
                continue;
            }
            const parsed = parseTitlePath(path);
            let title = titles.get(parsed.titleId);
            if (!title) {
                title = { titleId: parsed.titleId, directory: NAND_ROOT + "/" + parsed.high + "/" + parsed.low + "/content" };
                titles.set(parsed.titleId, title);
            }
            if (title[parsed.kind]) {
                fail("duplicate", "Include only one version of each system-data title.");
            }
            if (parsed.kind === "app") {
                checkNcch(entry.bytes, parsed.titleId);
                title.app = { contentId: parsed.contentId, bytes: entry.bytes };
            } else {
                title.tmd = { ...checkTmd(entry.bytes, parsed.titleId), bytes: entry.bytes };
            }
        }
        if (!titles.size) fail("empty", "The system-data archive contains no supported files.");
        const files = [];
        for (const title of titles.values()) {
            if (!title.app || !title.tmd) {
                fail("incomplete", "Each system-data title requires its matching .app and .tmd files.");
            }
            if (title.app.contentId !== title.tmd.contentId || title.app.bytes.byteLength !== title.tmd.contentSize) {
                fail("incomplete", "The title metadata does not match the included .app content ID and size.");
            }
            files.push({ filename: title.directory + "/" + title.app.contentId + ".app", bytes: title.app.bytes, titleId: title.titleId });
            // Azahar selects the lowest TMD filename, independently of its content ID.
            files.push({ filename: title.directory + "/00000000.tmd", bytes: title.tmd.bytes, titleId: title.titleId });
        }
        return files;
    }

    return Object.freeze({ NAND_ROOT, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_ARCHIVE_BYTES, MAX_ENTRIES, TITLE_NAMES, SystemDataError, assertZip, extractZip, prepareFiles });
});
