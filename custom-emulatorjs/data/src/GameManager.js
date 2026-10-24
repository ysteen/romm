class EJS_GameManager {
    constructor(Module, EJS) {
        this.EJS = EJS;
        this.Module = Module;
        this.FS = this.Module.FS;
        this.saveSessionStartedAt = Date.now();
        this.functions = {
            restart: this.Module.cwrap("system_restart", "", []),
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

        this.EJS.on("exit", (options) => {
            if (this.exitInProgress) return;
            this.exitInProgress = true;
            // Preserve upstream shutdown semantics for cores with a single
            // save file. Some cores only commit their final SRAM on restart.
            if (!this.usesSaveDirectory()) {
                if (!this.EJS.failedToStart) {
                    this.saveSaveFiles();
                    if (options?.restart !== false) {
                        this.functions.restart();
                        this.saveSaveFiles();
                    }
                }
                clearInterval(this.EJS.saveSaveInterval);
                this.EJS.saveSaveInterval = null;
                this.toggleMainLoop(0);
                this.FS.unmount("/data/saves");
                setTimeout(() => {
                    try {
                        this.Module.abort();
                    } catch(e) {
                        console.warn(e);
                    }
                }, 1000);
                return;
            }

            // Directory-backed cores flush their virtual save filesystem
            // directly. Avoid a synchronous core restart during navigation.
            if (this.EJS.saveSaveInterval) {
                clearInterval(this.EJS.saveSaveInterval);
                this.EJS.saveSaveInterval = null;
            }

            if (!this.EJS.failedToStart && !this.discardDosBoxPureSaveCacheOnExit) {
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
        return new Promise((resolve, reject) => {
            this.mkdir("/data");
            this.mkdir("/data/saves");
            this.FS.mount(this.FS.filesystems.IDBFS, { autoPersist: true }, "/data/saves");
            this.FS.syncfs(true, error => {
                // Do not boot or import over an apparently empty Azahar NAND
                // when reading existing persistent storage actually failed.
                if (error && this.isAzahar()) reject(error);
                else resolve();
            });
        });
    }
    async withAzaharSystemDataTransaction(action) {
        const idbfs = this.FS.filesystems?.IDBFS;
        const mount = this.FS.lookupPath("/data/saves").node.mount;
        if (!idbfs || typeof idbfs.queuePersist !== "function" || !mount || this.azaharImportPending) {
            throw new Error("This runtime cannot safely import persistent Azahar system data.");
        }
        this.azaharImportPending = true;
        const original = idbfs.queuePersist;
        // IDBFS installs its auto-persist hooks at mount time. Temporarily
        // suspend only this mount; toggling mount.opts.autoPersist is not enough.
        idbfs.queuePersist = function (candidate) {
            if (candidate !== mount) return original.call(this, candidate);
        };
        try {
            const deadline = Date.now() + 10000;
            while (mount.idbPersistState) {
                if (Date.now() >= deadline) throw new Error("Azahar browser storage is busy. Try again after restarting the player.");
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            return await action();
        } finally {
            idbfs.queuePersist = original;
            this.azaharImportPending = false;
            original.call(idbfs, mount);
        }
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
    async loadExternalFiles() {
        const externalFiles = this.EJS.config.externalFiles;
        if (!externalFiles || externalFiles.constructor.name !== "Object") return;
        for (const [path, url] of Object.entries(externalFiles)) {
            if (await this.getSaveFileAdapter()?.loadExternalFile(path, url)) continue;
            try {
                const extractToDirectory = path.trim().endsWith("/");
                const cacheItem = await this.EJS.downloadFile(
                    url, this.EJS.downloadType.support.name, null, true,
                    { responseType: "arraybuffer" }, extractToDirectory,
                    this.EJS.downloadType.support.dontCache, false
                );
                if (extractToDirectory) {
                    for (const file of cacheItem.data.files) this.writeFile(path + file.filename, file.bytes);
                } else if (cacheItem.data.files.length) {
                    this.writeFile(path, cacheItem.data.files[0].bytes);
                }
                if (path.startsWith("/data/saves")) {
                    await new Promise((resolve, reject) => this.FS.syncfs(false, error => error ? reject(error) : resolve()));
                }
            } catch (error) {
                if (this.EJS.debug) console.warn(`Failed to fetch external file '${url}'`, error);
            }
        }
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
            (this.isPpsspp() ? "core_info_savestate_bypass = true\n" : "") +
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
        if (this.isAzahar() && !this.supportsStates()) {
            throw new Error("This Azahar core does not support safe manual states. Update the core first.");
        }
        const state = this.Module.EmulatorJSGetState();
        if (this.isAzahar() && (!(state instanceof Uint8Array) || !state.byteLength)) {
            throw new Error("Azahar could not capture a state.");
        }
        return state;
    }
    loadState(state) {
        if (this.isAzahar()) {
            if (!this.supportsStates()) {
                throw new Error("This Azahar core does not support safe manual states. Update the core first.");
            }
            if (!(state instanceof Uint8Array) || !state.byteLength || state.byteLength > 256 * 1024 * 1024) {
                throw new Error("Invalid Azahar state size (maximum 256 MiB).");
            }
            const path = "/azahar-manual.state";
            this.clearEJSResetTimer();
            try {
                this.FS.writeFile(path, state);
                // The ordinary load_state export only queues a task and returns
                // its input argument. It cannot report a failed restore.
                const loaded = this.Module.cwrap("load_state_sync", "number", ["string"])(path);
                if (loaded !== 1) {
                    throw new Error("Azahar rejected the state. Check the game/core/system data; restart before continuing if rendering is incorrect.");
                }
            } finally {
                try { this.FS.unlink(path); } catch (e) {}
            }
            return;
        }
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
    capturePendingScreenshots() {
        this.pendingScreenshots?.forEach(capture => capture());
    }
    async screenshot() {
        if (this.isAzahar()) {
            // RetroArch's cached-frame readback disturbs Azahar's shared GL state.
            const source = this.EJS.canvas;
            if (!source?.width || !source?.height) throw new Error("Azahar canvas is unavailable");
            const capture = document.createElement("canvas");
            capture.width = source.width;
            capture.height = source.height;
            const context = capture.getContext("2d");
            if (!context) throw new Error("Could not create screenshot canvas");
            const pending = this.pendingScreenshots ??= new Set();
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(copyFrame);
                    reject(new Error("Azahar screenshot timed out"));
                }, 2000);
                const copyFrame = () => {
                    try {
                        context.drawImage(source, 0, 0);
                        // A discarded WebGL buffer is transparent, even when the game frame is opaque.
                        if (context.getImageData(capture.width >> 1, capture.height >> 1, 1, 1).data[3] === 0) {
                            return;
                        }
                        clearTimeout(timer);
                        pending.delete(copyFrame);
                        resolve();
                    } catch (error) {
                        clearTimeout(timer);
                        pending.delete(copyFrame);
                        reject(error);
                    }
                };
                pending.add(copyFrame);
            });
            const blob = await new Promise(resolve => capture.toBlob(resolve, "image/png"));
            if (!blob) throw new Error("Could not encode screenshot");
            return new Uint8Array(await blob.arrayBuffer());
        }
        try {
            this.FS.unlink("/screenshot.png");
        } catch(e) {}
        this.functions.screenshot();
        return new Promise(async (resolve) => {
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
        if (this.isAzahar()) {
            try {
                this.loadState(this.FS.readFile("/" + slot + "-quick.state"));
                return true;
            } catch (error) {
                console.warn("Azahar quick state restore failed", error);
                return false;
            }
        }
        (async () => {
            let name = slot + "-quick.state";
            this.clearEJSResetTimer();
            this.functions.loadState(name, 0);
        })();
    }
    simulateInput(player, index, value) {
        if (this.isAzahar() && [24, 25].includes(index)) {
            if (value === 1) {
                if (index === 24) void this.EJS.saveState();
                else void this.EJS.loadState();
            }
            return;
        }
        this.EJS.recordInputTelemetry?.("retro-input", { player, index, value });
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
                if (this.quickLoad(slot) !== false) {
                    this.EJS.displayMessage(this.EJS.localization("LOADED STATE FROM SLOT") + " " + slot);
                } else {
                    this.EJS.displayMessage(this.EJS.localization("FAILED TO LOAD STATE"));
                }
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
    getSaveFileAdapter() {
        if (this.saveFileAdapter === undefined) {
            this.saveFileAdapter = this.EJS.config?.saveFileAdapter?.(this) || null;
        }
        return this.saveFileAdapter;
    }
    getSaveFileName(data) {
        return this.getSaveFileAdapter()?.fileName(data) || this.getSaveFilePath().split("/").pop();
    }
    saveSaveFiles() {
        this.functions.saveSaveFiles();
        this.EJS.callEvent("saveSaveFiles", this.getSaveFile(false));
        if (this.usesSaveDirectory()) this.syncSaveFileSystem();
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
    async flushDosBoxPureSaveCache() {
        if (!this.isDosBoxPure()) return;

        // The RomM player calls this only after it has uploaded the final save
        // bundle (or when the user explicitly quits without saving). Prevent
        // the exit handler and the periodic timer from recreating files while
        // the shared IDBFS save directory is being cleared.
        this.discardDosBoxPureSaveCacheOnExit = true;
        this.saveSyncPending = false;
        if (this.EJS.saveSaveInterval) {
            clearInterval(this.EJS.saveSaveInterval);
            this.EJS.saveSaveInterval = null;
        }

        const deadline = Date.now() + 3000;
        while (this.saveSyncInFlight && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        const removeTree = (path) => {
            if (!this.FS.analyzePath(path).exists) return;
            for (const name of this.FS.readdir(path)) {
                if (name === "." || name === "..") continue;
                const child = path + "/" + name;
                const stat = this.FS.stat(child);
                if (this.FS.isDir(stat.mode)) {
                    removeTree(child);
                    this.FS.rmdir(child);
                } else {
                    this.FS.unlink(child);
                }
            }
        };

        removeTree("/data/saves");
        await new Promise((resolve, reject) => {
            this.FS.syncfs(false, (error) => error ? reject(error) : resolve());
        });
        if (typeof window.__reportBrowserLog === "function") {
            window.__reportBrowserLog("dosbox-save-cache-flush", "Cleared /data/saves after quit");
        }
    }
    supportsStates() {
        if (this.isAzahar()) {
            return typeof this.Module._load_state_sync === "function" && !!this.functions.supportsStates();
        }
        return this.isPpsspp() || !!this.functions.supportsStates();
    }
    setControllerPortDevice(port, device) {
        this.EJS.recordInputTelemetry?.("controller-port-device", { port, device });
        this.functions.setControllerPortDevice(port, device);
    }
    getControllerPortInfo() {
        const info = this.functions.getControllerPortInfo();
        this.EJS.recordInputTelemetry?.("controller-port-info", { info });
        return info;
    }
    getSaveFile(save) {
        if (save !== false) {
            this.saveSaveFiles();
        }
        const adapter = this.getSaveFileAdapter();
        if (adapter) return adapter.read();
        const exists = this.FS.analyzePath(this.getSaveFilePath()).exists;
        return (exists ? this.FS.readFile(this.getSaveFilePath()) : null);
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
    usesSaveDirectory() {
        return this.isDosBoxPure() || this.isPpsspp() || this.isAzahar();
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
