class EJS_GameManager {
    constructor(Module, EJS) {
        this.EJS = EJS;
        this.Module = Module;
        this.FS = this.Module.FS;
        this.functions = {
            restart: this.Module.cwrap("system_restart", "", []),
            //saveStateInfo: this.Module.cwrap("save_state_info", "string", []),
            loadState: this.Module.cwrap("load_state", "number", ["string", "number"]),
            screenshot: this.Module.cwrap("cmd_take_screenshot", "", []),
            simulateInput: this.Module.cwrap("simulate_input", "null", ["number", "number", "number"]),
            toggleMainLoop: this.Module.cwrap("toggleMainLoop", "null", ["number"]),
            getCoreOptions: this.Module.cwrap("get_core_options", "string", []),
            setVariable: this.Module.cwrap("ejs_set_variable", "null", ["string", "string"]),
            setCheat: this.Module.cwrap("set_cheat", "null", ["number", "number", "string"]),
            resetCheat: this.Module.cwrap("reset_cheat", "null", []),
            toggleShader: this.Module.cwrap("shader_enable", "null", ["number"]),
            getDiskCount: this.Module.cwrap("get_disk_count", "number", []),
            getCurrentDisk: this.Module.cwrap("get_current_disk", "number", []),
            setCurrentDisk: this.Module.cwrap("set_current_disk", "null", ["number"]),
            getSaveFilePath: this.Module.cwrap("save_file_path", "string", []),
            saveSaveFiles: this.Module.cwrap("cmd_savefiles", "", []),
            supportsStates: this.Module.cwrap("supports_states", "number", []),
            loadSaveFiles: this.Module.cwrap("refresh_save_files", "null", []),
            toggleFastForward: this.Module.cwrap("toggle_fastforward", "null", ["number"]),
            setFastForwardRatio: this.Module.cwrap("set_ff_ratio", "null", ["number"]),
            toggleRewind: this.Module.cwrap("toggle_rewind", "null", ["number"]),
            setRewindGranularity: this.Module.cwrap("set_rewind_granularity", "null", ["number"]),
            toggleSlowMotion: this.Module.cwrap("toggle_slow_motion", "null", ["number"]),
            setSlowMotionRatio: this.Module.cwrap("set_sm_ratio", "null", ["number"]),
            getFrameNum: this.Module.cwrap("get_current_frame_count", "number", [""]),
            setVSync: this.Module.cwrap("set_vsync", "null", ["number"]),
            setVideoRoation: this.Module.cwrap("set_video_rotation", "null", ["number"]),
            getVideoDimensions: this.Module.cwrap("get_video_dimensions", "number", ["string"]),
            setKeyboardEnabled: this.Module.cwrap("ejs_set_keyboard_enabled", "null", ["number"]),
            setControllerPortDevice: this.Module.cwrap("ejs_set_controller_port_device", "null", ["number", "number"]),
            getControllerPortInfo: this.Module.cwrap("ejs_get_controller_port_info", "string", [])
        }

        this.writeFile("/home/web_user/.config/retroarch/retroarch.cfg", this.getRetroArchCfg());

        this.writeConfigFile();
        this.initShaders();
        this.setupPreLoadSettings();

        this.EJS.on("exit", () => {
            if (this.exitInProgress) return;
            this.exitInProgress = true;

            // Stop periodic saves before the final flush. Restarting a running
            // Windows guest here blocks the browser main thread and prevents
            // RomM from completing its route change after Save & Quit.
            if (this.EJS.saveSaveInterval) {
                clearInterval(this.EJS.saveSaveInterval);
                this.EJS.saveSaveInterval = null;
            }

            if (!this.EJS.failedToStart) {
                this.saveSaveFiles();
            }
            this.toggleMainLoop(0);

            const finishExit = () => {
                if (this.exitFinished) return;
                this.exitFinished = true;
                try {
                    this.FS.unmount("/data/saves");
                } catch (e) {
                    if (this.EJS.debug) console.warn("Save filesystem unmount failed", e);
                }
                setTimeout(() => {
                    try {
                        this.Module.abort();
                    } catch(e) {
                        if (this.EJS.debug) console.warn(e);
                    }
                }, 0);
            };

            // saveSaveFiles() starts an asynchronous IDBFS sync. Let it finish
            // before unmounting; use a timeout so navigation can never hang.
            const waitForSaveSync = () => {
                if (this.saveSyncInFlight) {
                    setTimeout(waitForSaveSync, 50);
                } else {
                    finishExit();
                }
            };
            setTimeout(finishExit, 3000);
            waitForSaveSync();
        })
    }
    setupPreLoadSettings() {
        this.Module.callbacks.setupCoreSettingFile = (filePath) => {
            if (this.EJS.debug) console.log("Setting up core settings with path:", filePath);
            this.writeFile(filePath, this.EJS.getCoreSettings());
        }
    }
    mountFileSystems() {
        return new Promise(async resolve => {
            this.mkdir("/data");
            this.mkdir("/data/saves");
            this.FS.mount(this.FS.filesystems.IDBFS, { autoPersist: true }, "/data/saves");
            this.FS.syncfs(true, resolve);
        });
    }
    writeConfigFile() {
        if (!this.EJS.defaultCoreOpts.file || !this.EJS.defaultCoreOpts.settings) {
            return;
        }
        let output = "";
        for (const k in this.EJS.defaultCoreOpts.settings) {
            output += k + ' = "' + this.EJS.defaultCoreOpts.settings[k] + '"\n';
        }

        this.writeFile("/home/web_user/retroarch/userdata/config/" + this.EJS.defaultCoreOpts.file, output);
    }
    loadExternalFiles() {
        return new Promise(async (resolve, reject) => {
            if (this.EJS.config.externalFiles && this.EJS.config.externalFiles.constructor.name === "Object") {
                for (const key in this.EJS.config.externalFiles) {
                    await new Promise(async (done) => {
                        try {
                            const url = this.EJS.config.externalFiles[key];
                            
                            const extractToDirectory = key.trim().endsWith("/");
                            const cacheItem = await this.EJS.downloadFile(
                                url,
                                this.EJS.downloadType.support.name,
                                null,          // progress callback
                                true,          // notWithPath (URL is already absolute)
                                { responseType: "arraybuffer" },  // opts (was null → causes crash)
                                extractToDirectory, // forceExtract archives even when RomM names them .srm
                                this.EJS.downloadType.support.dontCache,
                                false          // dontExtract
                            );
                            
                            let path = key;
                            if (key.trim().endsWith("/")) {
                                // Extract to directory
                                for (let i = 0; i < cacheItem.data.files.length; i++) {
                                    const file = cacheItem.data.files[i];
                                    this.writeFile(path + file.filename, file.bytes);
                                }
                            } else {
                                // Write single file (or first file from archive)
                                if (cacheItem.data.files.length > 0) {
                                    this.writeFile(path, cacheItem.data.files[0].bytes);
                                }
                            }
                            if (path.startsWith("/data/saves")) {
                                await new Promise((syncDone) => this.FS.syncfs(false, syncDone));
                            }
                            done();
                        } catch (e) {
                            if (this.EJS.debug) console.warn("Failed to fetch file from '" + this.EJS.config.externalFiles[key] + "'. Make sure the file exists.", e);
                            done();
                        }
                    })
                }
            }
            resolve();
        });
    }
    writeFile(path, data) {
        const parts = path.split("/");
        let current = "/";
        for (let i = 0; i < parts.length - 1; i++) {
            if (!parts[i].trim()) continue;
            current += parts[i] + "/";
            this.mkdir(current);
        }
        this.FS.writeFile(path, data);
    }
    mkdir(path) {
        try {
            this.FS.mkdir(path);
        } catch(e) {}
    }
    getRetroArchCfg() {
        let cfg = "autosave_interval = 60\n" +
            "screenshot_directory = \"/\"\n" +
            "block_sram_overwrite = false\n" +
            "video_gpu_screenshot = false\n" +
            "audio_latency = 64\n" +
            "video_top_portrait_viewport = true\n" +
            "video_vsync = true\n" +
            "video_smooth = false\n" +
            "fastforward_ratio = 3.0\n" +
            "slowmotion_ratio = 3.0\n" +
            (this.EJS.rewindEnabled ? "rewind_enable = true\n" : "") +
            (this.EJS.rewindEnabled ? "rewind_granularity = 6\n" : "") +
            "savefile_directory = \"/data/saves\"\n";

        if (this.EJS.retroarchOpts && Array.isArray(this.EJS.retroarchOpts)) {
            this.EJS.retroarchOpts.forEach(option => {
                let selected = this.EJS.preGetSetting(option.name);
                console.log(selected);
                if (!selected) {
                    selected = option.default;
                }
                const value = option.isString === false ? selected : '"' + selected + '"';
                cfg += option.name + " = " + value + "\n"
            })
        }
        return cfg;
    }
    writeBootupBatchFile() {
        const data = `
SET BLASTER=A220 I7 D1 H5 T6

@ECHO OFF
mount A / -t floppy
SET PATH=Z:\;A:\
mount c /emulator/c
c:
IF EXIST AUTORUN.BAT CALL AUTORUN.BAT
`;
        const filename = "BOOTUP.BAT";
        this.FS.writeFile("/" + filename, data);
        return filename;
    }
    initShaders() {
        if (!this.EJS.shaders) return;
        this.mkdir("/shader");
        for (const shaderFileName in this.EJS.shaders) {
            const shader = this.EJS.shaders[shaderFileName];
            if (typeof shader === "string") {
                this.FS.writeFile(`/shader/${shaderFileName}`, shader);
            }
        }
    }
    clearEJSResetTimer() {
        if (this.EJS.resetTimeout) {
            clearTimeout(this.EJS.resetTimeout);
            delete this.EJS.resetTimeout;
        }
    }
    restart() {
        this.clearEJSResetTimer();
        if (this.EJS.config.disableRestart === true) {
            const stack = new Error("Frontend restart blocked").stack;
            console.warn("[DOSBOX TEST] Frontend restart blocked", stack);
            window.__reportBrowserLog?.("restart-blocked", stack);
            return;
        }
        this.functions.restart();
    }
    getState() {
        return this.Module.EmulatorJSGetState();
    }
    loadState(state) {
        try {
            this.FS.unlink("game.state");
        } catch(e) {}
        this.FS.writeFile("/game.state", state);
        this.clearEJSResetTimer();
        this.functions.loadState("game.state", 0);
        setTimeout(() => {
            try {
                this.FS.unlink("game.state");
            } catch(e) {}
        }, 5000)
    }
    screenshot() {
        try {
            this.FS.unlink("/screenshot.png");
        } catch(e) {}
        this.functions.screenshot();
        return new Promise(async resolve => {
            while (1) {
                try {
                    this.FS.stat("/screenshot.png");
                    return resolve(this.FS.readFile("/screenshot.png"));
                } catch(e) {}
                await new Promise(res => setTimeout(res, 50));
            }
        })
    }
    quickSave(slot) {
        if (!slot) slot = 1;
        let name = slot + "-quick.state";
        try {
            this.FS.unlink(name);
        } catch(e) {}
        try {
            let data = this.getState();
            this.FS.writeFile("/" + name, data);
        } catch(e) {
            return false;
        }
        return true;
    }
    quickLoad(slot) {
        if (!slot) slot = 1;
        (async () => {
            let name = slot + "-quick.state";
            this.clearEJSResetTimer();
            this.functions.loadState(name, 0);
        })();
    }
    simulateInput(player, index, value) {
        if (this.EJS.isNetplay) {
            this.EJS.netplay.simulateInput(player, index, value);
            return;
        }
        if ([24, 25, 26, 27, 28, 29].includes(index)) {
            if (index === 24 && value === 1) {
                const slot = this.EJS.settings["save-state-slot"] ? this.EJS.settings["save-state-slot"] : "1";
                if (this.quickSave(slot)) {
                    this.EJS.displayMessage(this.EJS.localization("SAVED STATE TO SLOT") + " " + slot);
                } else {
                    this.EJS.displayMessage(this.EJS.localization("FAILED TO SAVE STATE"));
                }
            }
            if (index === 25 && value === 1) {
                const slot = this.EJS.settings["save-state-slot"] ? this.EJS.settings["save-state-slot"] : "1";
                this.quickLoad(slot);
                this.EJS.displayMessage(this.EJS.localization("LOADED STATE FROM SLOT") + " " + slot);
            }
            if (index === 26 && value === 1) {
                let newSlot;
                try {
                    newSlot = parseFloat(this.EJS.settings["save-state-slot"] ? this.EJS.settings["save-state-slot"] : "1") + 1;
                } catch(e) {
                    newSlot = 1;
                }
                if (newSlot > 9) newSlot = 1;
                this.EJS.displayMessage(this.EJS.localization("SET SAVE STATE SLOT TO") + " " + newSlot);
                this.EJS.changeSettingOption("save-state-slot", newSlot.toString());
            }
            if (index === 27) {
                this.functions.toggleFastForward(this.EJS.isFastForward ? !value : value);
            }
            if (index === 29) {
                this.functions.toggleSlowMotion(this.EJS.isSlowMotion ? !value : value);
            }
            if (index === 28) {
                if (this.EJS.rewindEnabled) {
                    this.functions.toggleRewind(value);
                }
            }
            return;
        }
        this.functions.simulateInput(player, index, value);
    }
    getFileNames() {
        if (this.EJS.getCore() === "picodrive") {
            return ["bin", "gen", "smd", "md", "32x", "cue", "iso", "sms", "68k", "chd"];
        } else {
            return ["toc", "ccd", "exe", "pbp", "chd", "img", "bin", "iso"];
        }
    }
    createCueFile(fileNames) {
        try {
            if (fileNames.length > 1) {
                fileNames = fileNames.filter((item) => {
                    return this.getFileNames().includes(item.split(".").pop().toLowerCase());
                })
                fileNames = fileNames.sort((a, b) => {
                    if (isNaN(a.charAt()) || isNaN(b.charAt())) throw new Error("Incorrect file name format");
                    return (parseInt(a.charAt()) > parseInt(b.charAt())) ? 1 : -1;
                })
            }
        } catch(e) {
            if (fileNames.length > 1) {
                console.warn("Could not auto-create cue file(s).");
                return null;
            }
        }
        for (let i = 0; i < fileNames.length; i++) {
            if (fileNames[i].split(".").pop().toLowerCase() === "ccd") {
                console.warn("Did not auto-create cue file(s). Found a ccd.");
                return null;
            }
        }
        if (fileNames.length === 0) {
            console.warn("Could not auto-create cue file(s).");
            return null;
        }
        let baseFileName = fileNames[0].split("/").pop();
        if (baseFileName.includes(".")) {
            baseFileName = baseFileName.substring(0, baseFileName.length - baseFileName.split(".").pop().length - 1);
        }
        for (let i = 0; i < fileNames.length; i++) {
            const contents = " FILE \"" + fileNames[i] + "\" BINARY\n  TRACK 01 MODE1/2352\n   INDEX 01 00:00:00";
            this.FS.writeFile("/" + baseFileName + "-" + i + ".cue", contents);
        }
        if (fileNames.length > 1) {
            let contents = "";
            for (let i = 0; i < fileNames.length; i++) {
                contents += "/" + baseFileName + "-" + i + ".cue\n";
            }
            this.FS.writeFile("/" + baseFileName + ".m3u", contents);
        }
        return (fileNames.length === 1) ? baseFileName + "-0.cue" : baseFileName + ".m3u";
    }
    loadPpssppAssets() {
        return new Promise(async (resolve, reject) => {
            try {
                const res = await this.EJS.downloadFile("cores/ppsspp-assets.zip", this.EJS.downloadType.core.name, null, false, { responseType: "arraybuffer", method: "GET" }, true, this.EJS.downloadType.core.dontCache);
                if (res === -1) {
                    throw new Error("Failed to download PPSSPP assets");
                }
                const cacheItem = res.data;

                this.mkdir("/PPSSPP");

                for (let i = 0; i < cacheItem.files.length; i++) {
                    const file = cacheItem.files[i];
                    const path = "/PPSSPP/" + file.filename;
                    const paths = path.split("/");
                    let cp = "";
                    for (let j = 0; j < paths.length - 1; j++) {
                        if (paths[j] === "") continue;
                        cp += "/" + paths[j];
                        if (!this.FS.analyzePath(cp).exists) {
                            this.FS.mkdir(cp);
                        }
                    }
                    if (!path.endsWith("/")) {
                        this.FS.writeFile(path, file.bytes);
                    }
                }
                resolve();
            } catch (error) {
                this.EJS.textElem.innerText = this.EJS.localization("Network Error");
                this.EJS.textElem.style.color = "red";
                reject(error);
            }
        })
    }
    setVSync(enabled) {
        this.functions.setVSync(enabled);
    }
    toggleMainLoop(playing) {
        this.functions.toggleMainLoop(playing);
    }
    getCoreOptions() {
        return this.functions.getCoreOptions();
    }
    setVariable(option, value) {
        this.functions.setVariable(option, value);
    }
    setCheat(index, enabled, code) {
        this.functions.setCheat(index, enabled, code);
    }
    resetCheat() {
        this.functions.resetCheat();
    }
    toggleShader(active) {
        this.functions.toggleShader(active);
    }
    getDiskCount() {
        return this.functions.getDiskCount();
    }
    getCurrentDisk() {
        return this.functions.getCurrentDisk();
    }
    setCurrentDisk(disk) {
        this.functions.setCurrentDisk(disk);
    }
    getSaveFilePath() {
        return this.functions.getSaveFilePath();
    }
    saveSaveFiles() {
        this.functions.saveSaveFiles();
        this.EJS.callEvent("saveSaveFiles", this.getSaveFile(false));
        this.syncSaveFileSystem();
    }
    syncSaveFileSystem() {
        // IDBFS only restores files that have been flushed with syncfs(false).
        // DOSBox Pure writes its .pure.zip disk differences directly under
        // /data/saves, so syncing only RetroArch's nominal SRAM file is not
        // enough. Coalesce overlapping periodic sync requests.
        if (this.saveSyncInFlight) {
            this.saveSyncPending = true;
            return;
        }
        this.saveSyncInFlight = true;
        this.FS.syncfs(false, (error) => {
            this.saveSyncInFlight = false;
            if (typeof window.__reportBrowserLog === "function") {
                window.__reportBrowserLog(error ? "save-sync-error" : "save-sync", error ? String(error) : "IDBFS flush complete");
            }
            if (error) console.error("Failed to persist /data/saves to IDBFS:", error);
            if (this.saveSyncPending) {
                this.saveSyncPending = false;
                this.syncSaveFileSystem();
            }
        });
    }
    supportsStates() {
        return !!this.functions.supportsStates();
    }
    setControllerPortDevice(port, device) {
        this.functions.setControllerPortDevice(port, device);
    }
    getControllerPortInfo() {
        return this.functions.getControllerPortInfo();
    }
    getSaveFile(save) {
        if (save !== false) {
            this.saveSaveFiles();
        }
        if (this.isDosBoxPure()) {
            const bundle = this.createDosBoxPureSaveBundle();
            if (bundle) return bundle;
        }
        const exists = this.FS.analyzePath(this.getSaveFilePath()).exists;
        return (exists ? this.FS.readFile(this.getSaveFilePath()) : null);
    }
    isDosBoxPure() {
        return ["dos", "dosbox_pure"].includes(this.EJS.getCore());
    }
    getDosBoxPureSaveFiles() {
        const savePath = this.getSaveFilePath();
        const saveName = savePath.split("/").pop();
        const stem = saveName.includes(".") ? saveName.substring(0, saveName.lastIndexOf(".")) : saveName;
        const root = "/data/saves";
        const saveDirectory = savePath.substring(0, savePath.lastIndexOf("/")) || root;
        const result = [];
        if (!this.FS.analyzePath(saveDirectory).exists) return result;
        for (const name of this.FS.readdir(saveDirectory)) {
            if (name === "." || name === "..") continue;
            const path = saveDirectory + "/" + name;
            const stat = this.FS.stat(path);
            if (!this.FS.isFile(stat.mode)) continue;
            // DOSBox Pure uses one or more of these siblings for a title:
            // .srm, .pure.zip, -CDRIVE.sav and -<content hash>.sav.
            if (name === saveName || name.startsWith(stem + ".") || name.startsWith(stem + "-")) {
                // Keep the core-specific subdirectory (usually DOSBox-pure/)
                // so extraction recreates the exact paths the core will open.
                result.push({ name: path.substring(root.length + 1), bytes: this.FS.readFile(path) });
            }
        }
        return result;
    }
    crc32(data) {
        if (!EJS_GameManager.crcTable) {
            EJS_GameManager.crcTable = new Uint32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
                EJS_GameManager.crcTable[n] = c >>> 0;
            }
        }
        let crc = 0xffffffff;
        for (const value of data) crc = EJS_GameManager.crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8);
        return (crc ^ 0xffffffff) >>> 0;
    }
    createDosBoxPureSaveBundle() {
        const files = this.getDosBoxPureSaveFiles();
        if (!files.length) return null;
        const encoder = new TextEncoder();
        const entries = files.map((file) => ({
            ...file,
            fileName: encoder.encode(file.name),
            crc: this.crc32(file.bytes)
        }));
        const localSize = entries.reduce((sum, file) => sum + 30 + file.fileName.length + file.bytes.length, 0);
        const centralSize = entries.reduce((sum, file) => sum + 46 + file.fileName.length, 0);
        const output = new Uint8Array(localSize + centralSize + 22);
        const view = new DataView(output.buffer);
        const write16 = (offset, value) => view.setUint16(offset, value, true);
        const write32 = (offset, value) => view.setUint32(offset, value >>> 0, true);
        let offset = 0;
        for (const file of entries) {
            file.offset = offset;
            write32(offset, 0x04034b50); write16(offset + 4, 20); write16(offset + 6, 0x0800);
            write16(offset + 8, 0); write16(offset + 10, 0); write16(offset + 12, 0);
            write32(offset + 14, file.crc); write32(offset + 18, file.bytes.length); write32(offset + 22, file.bytes.length);
            write16(offset + 26, file.fileName.length); write16(offset + 28, 0);
            output.set(file.fileName, offset + 30); output.set(file.bytes, offset + 30 + file.fileName.length);
            offset += 30 + file.fileName.length + file.bytes.length;
        }
        const centralOffset = offset;
        for (const file of entries) {
            write32(offset, 0x02014b50); write16(offset + 4, 20); write16(offset + 6, 20); write16(offset + 8, 0x0800);
            write16(offset + 10, 0); write16(offset + 12, 0); write16(offset + 14, 0);
            write32(offset + 16, file.crc); write32(offset + 20, file.bytes.length); write32(offset + 24, file.bytes.length);
            write16(offset + 28, file.fileName.length); write16(offset + 30, 0); write16(offset + 32, 0);
            write16(offset + 34, 0); write16(offset + 36, 0); write32(offset + 38, 0); write32(offset + 42, file.offset);
            output.set(file.fileName, offset + 46);
            offset += 46 + file.fileName.length;
        }
        write32(offset, 0x06054b50); write16(offset + 4, 0); write16(offset + 6, 0);
        write16(offset + 8, entries.length); write16(offset + 10, entries.length);
        write32(offset + 12, centralSize); write32(offset + 16, centralOffset); write16(offset + 20, 0);
        if (this.EJS.debug) console.log("[DOSBOX SAVE] Bundled files:", entries.map((file) => `${file.name} (${file.bytes.length})`));
        return output;
    }
    loadSaveFiles() {
        this.clearEJSResetTimer();
        this.functions.loadSaveFiles();
    }
    setFastForwardRatio(ratio) {
        this.functions.setFastForwardRatio(ratio);
    }
    toggleFastForward(active) {
        this.functions.toggleFastForward(active);
    }
    setSlowMotionRatio(ratio) {
        this.functions.setSlowMotionRatio(ratio);
    }
    toggleSlowMotion(active) {
        this.functions.toggleSlowMotion(active);
    }
    setRewindGranularity(value) {
        this.functions.setRewindGranularity(value);
    }
    getFrameNum() {
        return this.functions.getFrameNum();
    }
    setVideoRotation(rotation) {
        this.functions.setVideoRoation(rotation);
    }
    getVideoDimensions(type) {
        try {
            return this.functions.getVideoDimensions(type);
        } catch(e) {
            console.warn(e);
        }
    }
    setKeyboardEnabled(enabled) {
        this.functions.setKeyboardEnabled(enabled === true ? 1 : 0);
    }
    setAltKeyEnabled(enabled) {
        this.functions.setKeyboardEnabled(enabled === true ? 3 : 2);
    }
    listDir(path, indent = "") {
        const skipPaths = ["/dev", "/proc", "/sys"];
        if (skipPaths.includes(path)) {
            console.warn(`Skipping directory listing for ${path}`);
            return;
        }
        try {
            const entries = this.FS.readdir(path);
            for (const entry of entries) {
                if (entry === "." || entry === "..") continue;
                const fullPath = path === "/" ? `/${entry}` : `${path}/${entry}`;
                if (skipPaths.some(skip => fullPath.startsWith(skip))) continue;
                const stat = this.FS.stat(fullPath);
                if (this.FS.isDir(stat.mode)) {
                    console.log(`${indent}[DIR] ${fullPath}`);
                    this.listDir(fullPath, indent + "  ");
                } else {
                    console.log(`${indent}${fullPath}`);
                }
            }
        } catch (e) {
            console.warn("Error reading directory:", path, e);
        }
    }
}

export { EJS_GameManager };
