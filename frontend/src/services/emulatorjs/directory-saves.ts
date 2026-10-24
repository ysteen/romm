import { unzipSync, zipSync } from "fflate";

interface SaveStat {
  mode: number;
  mtime: Date | number | string;
}

export interface SaveFileSystem {
  analyzePath(path: string): { exists: boolean };
  readdir(path: string): string[];
  stat(path: string): SaveStat;
  isFile(mode: number): boolean;
  isDir(mode: number): boolean;
  readFile(path: string): Uint8Array;
  open(path: string, mode: string): unknown;
  read(
    stream: unknown,
    bytes: Uint8Array,
    start: number,
    size: number,
    offset: number,
  ): number;
  close(stream: unknown): void;
  syncfs(populate: boolean, done: (error?: Error | null) => void): void;
}

export interface SaveManager {
  FS: SaveFileSystem;
  EJS: { getCore(): string; fileName?: string };
  saveSessionStartedAt: number;
  getSaveFilePath(): string;
  writeFile(path: string, bytes: Uint8Array): void;
  loadSaveFiles(): void;
}

interface SaveEntry {
  name: string;
  bytes: Uint8Array;
}
interface ImportEntry {
  filename: string;
  bytes: Uint8Array;
}

export function createDirectorySaveAdapter(manager: SaveManager) {
  return ["dos", "dosbox_pure", "ppsspp", "azahar"].includes(
    manager.EJS.getCore(),
  )
    ? new DirectorySaveAdapter(manager)
    : null;
}

declare global {
  interface Window {
    EJS_saveFileAdapter?: typeof createDirectorySaveAdapter;
  }
}

export class DirectorySaveAdapter {
  private manager: SaveManager;
  private azaharSaveRoots?: Partial<Record<"data" | "extdata", string>>;

  constructor(manager: SaveManager) {
    this.manager = manager;
  }

  get FS() {
    return this.manager.FS;
  }
  get EJS() {
    return this.manager.EJS;
  }
  get saveSessionStartedAt() {
    return this.manager.saveSessionStartedAt;
  }
  isDosBoxPure() {
    return ["dos", "dosbox_pure"].includes(this.EJS.getCore());
  }
  isPpsspp() {
    return this.EJS.getCore() === "ppsspp";
  }
  isAzahar() {
    return this.EJS.getCore() === "azahar";
  }
  getSaveFilePath() {
    return this.manager.getSaveFilePath();
  }
  writeFile(path: string, bytes: Uint8Array) {
    this.manager.writeFile(path, bytes);
  }

  read(): Uint8Array | null {
    if (this.isDosBoxPure()) return this.createDosBoxPureSaveBundle();
    if (this.isPpsspp()) return this.createPpssppSaveBundle();
    return this.createAzaharSaveBundle();
  }

  fileName(data?: Uint8Array | null) {
    const name = this.getSaveFilePath().split("/").pop()!;
    return data?.[0] === 0x50 && data?.[1] === 0x4b
      ? name.replace(/\.[^.]+$/, "") + ".zip"
      : name;
  }

  createZipSaveBundle(files: SaveEntry[]): Uint8Array | null {
    if (!files.length) return null;
    const entries = Object.fromEntries(
      files
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((file) => [file.name, file.bytes]),
    );
    return zipSync(entries, { level: 0, mtime: new Date(1980, 0, 1) });
  }

  async restore(data: Uint8Array, refresh = true) {
    const files = unzipSync(data);
    this.writeDirectorySaveFiles(
      Object.entries(files).map(([filename, bytes]) => ({ filename, bytes })),
    );
    await new Promise<void>((resolve, reject) =>
      this.FS.syncfs(false, (error) => (error ? reject(error) : resolve())),
    );
    if (refresh) this.manager.loadSaveFiles();
  }

  async loadExternalFile(path: string, url: string) {
    if (path !== "/data/saves/") return false;
    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to download save archive");
    await this.restore(new Uint8Array(await response.arrayBuffer()), false);
    return true;
  }
  getDosBoxPureSaveFiles(): SaveEntry[] {
    const savePath = this.getSaveFilePath();
    if (!savePath.startsWith("/data/saves/")) return [];
    const saveName = savePath.split("/").pop()!;
    const stem = saveName.includes(".")
      ? saveName.substring(0, saveName.lastIndexOf("."))
      : saveName;
    const root = "/data/saves";
    const saveDirectory =
      savePath.substring(0, savePath.lastIndexOf("/")) || root;
    const result: SaveEntry[] = [];
    if (!this.FS.analyzePath(saveDirectory).exists) return result;
    for (const name of this.FS.readdir(saveDirectory)) {
      if (name === "." || name === "..") continue;
      const path = saveDirectory + "/" + name;
      const stat = this.FS.stat(path);
      if (!this.FS.isFile(stat.mode)) continue;
      // DOSBox Pure uses one or more of these siblings for a title:
      // .srm, .pure.zip, -CDRIVE.sav and -<content hash>.sav.
      const suffix = name.substring(stem.length);
      if (
        name === saveName ||
        (name.startsWith(stem) &&
          /^(?:\.(?:pure\.zip|sav\.zip|sav)|-(?:[A-Z]DRIVE|[0-9A-F]{8})\.sav)$/i.test(
            suffix,
          ))
      ) {
        // Keep the core-specific subdirectory (usually DOSBox-pure/)
        // so extraction recreates the exact paths the core will open.
        result.push({
          name: path.substring(root.length + 1),
          bytes: this.FS.readFile(path),
        });
      }
    }
    return result;
  }
  getPpssppSaveFiles(): SaveEntry[] {
    const root = "/data/saves";
    const saveRoot = root + "/PPSSPP/PSP/SAVEDATA";
    const result: SaveEntry[] = [];
    if (!this.FS.analyzePath(saveRoot).exists) return result;

    const collectFiles = (path: string): { path: string; stat: SaveStat }[] => {
      const files = [];
      for (const name of this.FS.readdir(path)) {
        if (name === "." || name === "..") continue;
        const child = path + "/" + name;
        const stat = this.FS.stat(child);
        if (this.FS.isDir(stat.mode)) {
          files.push(...collectFiles(child));
        } else if (this.FS.isFile(stat.mode)) {
          files.push({ path: child, stat });
        }
      }
      return files;
    };

    // A changed save folder includes its unchanged companion files.
    const changedAfter = this.saveSessionStartedAt - 2000;
    for (const name of this.FS.readdir(saveRoot)) {
      if (name === "." || name === "..") continue;
      const path = saveRoot + "/" + name;
      const stat = this.FS.stat(path);
      const files = this.FS.isDir(stat.mode)
        ? collectFiles(path)
        : [{ path, stat }];
      const changed = files.some((file) => {
        const modifiedAt =
          file.stat.mtime instanceof Date
            ? file.stat.mtime.getTime()
            : new Date(file.stat.mtime).getTime();
        return modifiedAt >= changedAfter;
      });
      if (!changed) continue;
      for (const file of files) {
        result.push({
          name: file.path.substring(root.length + 1),
          bytes: this.FS.readFile(file.path),
        });
      }
    }
    return result;
  }
  getAzaharSaveFiles(): SaveEntry[] {
    const root = "/data/saves";
    const portableRoots = this.getAzaharSaveRoots();
    if (portableRoots) {
      return Object.values(portableRoots).flatMap((directory) =>
        this.collectSaveFiles(root + "/" + directory),
      );
    }
    // RetroArch gives the core /data/saves/Azahar as its save directory,
    // then Azahar appends its own Azahar user-directory component.
    const saveRoot = root + "/Azahar/Azahar/sdmc";
    if (!this.FS.analyzePath(saveRoot).exists) return [];

    const collectFiles = (path: string): { path: string; stat: SaveStat }[] => {
      const files = [];
      for (const name of this.FS.readdir(path)) {
        if (name === "." || name === "..") continue;
        const child = path + "/" + name;
        const stat = this.FS.stat(child);
        if (this.FS.isDir(stat.mode)) {
          files.push(...collectFiles(child));
        } else if (this.FS.isFile(stat.mode)) {
          files.push({ path: child, stat });
        }
      }
      return files;
    };

    const changedAfter = this.saveSessionStartedAt - 2000;
    const changedFiles = collectFiles(saveRoot).filter((file) => {
      const modifiedAt =
        file.stat.mtime instanceof Date
          ? file.stat.mtime.getTime()
          : new Date(file.stat.mtime).getTime();
      return modifiedAt >= changedAfter;
    });
    const saveDirectories = new Set<string>();
    for (const file of changedFiles) {
      const relativeParts = file.path.substring(saveRoot.length + 1).split("/");
      const marker = relativeParts.findIndex(
        (part) => part === "title" || part === "extdata",
      );
      if (marker >= 0 && relativeParts.length >= marker + 3) {
        saveDirectories.add(
          saveRoot + "/" + relativeParts.slice(0, marker + 3).join("/"),
        );
      } else {
        saveDirectories.add(file.path.substring(0, file.path.lastIndexOf("/")));
      }
    }

    const result: SaveEntry[] = [];
    const included = new Set<string>();
    for (const directory of saveDirectories) {
      for (const file of collectFiles(directory)) {
        if (included.has(file.path)) continue;
        included.add(file.path);
        result.push({
          name: file.path.substring(root.length + 1),
          bytes: this.FS.readFile(file.path),
        });
      }
    }
    return result;
  }
  collectSaveFiles(directory: string): SaveEntry[] {
    if (!this.FS.analyzePath(directory).exists) return [];
    const result: SaveEntry[] = [];
    for (const name of this.FS.readdir(directory)) {
      if (name === "." || name === "..") continue;
      const path = directory + "/" + name;
      const stat = this.FS.stat(path);
      if (this.FS.isDir(stat.mode)) result.push(...this.collectSaveFiles(path));
      else if (this.FS.isFile(stat.mode))
        result.push({
          name: path.substring("/data/saves/".length),
          bytes: this.FS.readFile(path),
        });
    }
    return result;
  }
  getAzaharSaveRoots(): Partial<Record<"data" | "extdata", string>> | null {
    if (this.azaharSaveRoots) return this.azaharSaveRoots;
    if (!this.EJS.fileName) return null;
    const path = "/" + this.EJS.fileName.replace(/^\/+/, "");
    if (!this.FS.analyzePath(path).exists) return null;
    const stream = this.FS.open(path, "r");
    try {
      const read = (offset: number, size: number) => {
        const bytes = new Uint8Array(size);
        if (this.FS.read(stream, bytes, 0, size, offset) !== size) return null;
        return new DataView(bytes.buffer);
      };
      // NCSD's first partition contains the executable NCCH. Only read
      // its headers; copying a whole 3DS ROM here can exhaust WASM memory.
      let offset = 0;
      let header = read(offset, 0x200);
      if (header?.getUint32(0x100, true) === 0x4453434e) {
        offset = header.getUint32(0x120, true) * 0x200;
        header = read(offset, 0x200);
      }
      if (header?.getUint32(0x100, true) !== 0x4843434e) return null;
      const hex = (value: number | bigint) =>
        value.toString(16).padStart(8, "0");
      const low = header.getUint32(0x118, true);
      const high = header.getUint32(0x11c, true);
      if (!high && !low) return null;
      let extdataId = BigInt(low >>> 8);
      // Decrypted ExHeader storage information can override the common
      // title-ID mapping, including titles with extended savedata access.
      if (
        header.getUint8(0x18f) & 4 &&
        header.getUint32(0x180, true) >= 0x400
      ) {
        const caps = read(offset + 0x400, 0x50);
        if (caps) {
          extdataId = caps.getBigUint64(0x30, true);
          if (caps.getUint8(0x4f) >> 1) {
            const ids = [caps.getBigUint64(0x40, true), extdataId].flatMap(
              (value) =>
                [40n, 20n, 0n].map((shift) => (value >> shift) & 0xfffffn),
            );
            extdataId = ids.find((value) => value !== 0n) || 0n;
          }
        }
      }
      const id = "00000000000000000000000000000000";
      const root = `Azahar/Azahar/sdmc/Nintendo 3DS/${id}/${id}`;
      const roots: Partial<Record<"data" | "extdata", string>> = {
        data: `${root}/title/${hex(high)}/${hex(low)}/data`,
      };
      if (extdataId) {
        // Azahar's archive backend uses uppercase hex for extdata.
        roots.extdata = `${root}/extdata/${hex(extdataId >> 32n).toUpperCase()}/${hex(extdataId & 0xffffffffn).toUpperCase()}`;
      }
      this.azaharSaveRoots = roots;
      return roots;
    } finally {
      this.FS.close(stream);
    }
  }
  createDosBoxPureSaveBundle() {
    return this.createZipSaveBundle(this.getDosBoxPureSaveFiles());
  }
  createPpssppSaveBundle() {
    const prefix = "PPSSPP/PSP/SAVEDATA/";
    const files = this.getPpssppSaveFiles().map((file) => ({
      ...file,
      name: file.name.substring(prefix.length),
    }));
    return this.createZipSaveBundle(files);
  }
  createAzaharSaveBundle() {
    const roots = this.getAzaharSaveRoots();
    const files = this.getAzaharSaveFiles().map((file) => {
      const root =
        roots &&
        Object.entries(roots).find(([, path]) =>
          file.name.startsWith(path + "/"),
        );
      return root
        ? { ...file, name: root[0] + file.name.substring(root[1].length) }
        : file;
    });
    return this.createZipSaveBundle(files);
  }
  writeDirectorySaveFiles(files: ImportEntry[]) {
    const prepared = new Map<string, Uint8Array>();
    for (const file of files) {
      const name = file.filename.replaceAll("\\", "/");
      if (
        !name ||
        name.startsWith("/") ||
        name.includes(":") ||
        name.includes("\0") ||
        name.includes("//") ||
        name.split("/").some((part) => part === ".." || part === ".")
      ) {
        throw new Error(`Unsafe save bundle path: ${file.filename}`);
      }
      if (name.endsWith("/")) continue;
      let target = name;
      if (this.isPpsspp()) {
        target = name.replace(
          /^(?:PPSSPP\/PSP\/SAVEDATA|PSP\/SAVEDATA|SAVEDATA)\//,
          "",
        );
        if (
          !target.includes("/") ||
          target.startsWith("PPSSPP/") ||
          target.startsWith("PSP/")
        )
          continue;
        target = "PPSSPP/PSP/SAVEDATA/" + target;
      } else if (this.isAzahar()) {
        if (/^(data|extdata)\//.test(name)) {
          const component = name.startsWith("data/") ? "data" : "extdata";
          const root = this.getAzaharSaveRoots()?.[component];
          if (!root)
            throw new Error(
              "Cannot determine the Azahar save location for this ROM",
            );
          target = root + name.substring(component.length);
        } else if (!name.startsWith("Azahar/Azahar/sdmc/")) {
          continue;
        }
      } else if (name.includes("/") && !name.startsWith("DOSBox-pure/")) {
        throw new Error(`Not a DOSBox Pure save path: ${name}`);
      }
      if (prepared.has(target))
        throw new Error(`Duplicate save bundle path: ${target}`);
      prepared.set(target, file.bytes);
    }
    if (!prepared.size)
      throw new Error("Save bundle contained no files for this core");
    for (const path of prepared.keys()) {
      const parts = path.split("/");
      while (parts.length > 1) {
        parts.pop();
        if (prepared.has(parts.join("/")))
          throw new Error(`Conflicting save bundle path: ${path}`);
      }
    }
    // Validate every entry before applying any file, including legacy bundles.
    for (const [path, bytes] of prepared)
      this.writeFile("/data/saves/" + path, bytes);
    return prepared.size;
  }
}
