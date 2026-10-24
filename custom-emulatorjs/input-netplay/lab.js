import { PROTOCOL, confirmedMemory, connectSession, gatherDescription, sha256 } from "../data/src/input-netplay.js?v=20261021.10";
import { linkCore } from "../data/src/link-core.js?v=20261021.10";

export const coreOptions = linkCore().options;

const players = new Set();

export async function bootPlayer(container, roms, audioPlayer = 0) {
    const iframe = document.createElement("iframe");
    iframe.title = "Linked Game Boy screens";
    iframe.allow = "autoplay; gamepad";
    iframe.src = "player.html?v=20261021.10";
    container.append(iframe);
    await new Promise((resolve, reject) => {
        iframe.onload = resolve;
        iframe.onerror = () => reject(new Error("Could not load player"));
    });
    players.add(iframe);
    const active = selected => {
        iframe.classList.toggle("is-active", selected);
        iframe.contentWindow.audioOutput?.setActive(selected);
    };
    iframe.contentWindow.selectPlayer = () => {
        for (const other of players) {
            if (!other.isConnected) { players.delete(other); continue; }
            if (other !== iframe) {
                other.classList.remove("is-active");
                other.contentWindow.audioOutput?.setActive(false);
            }
        }
        active(true);
    };
    iframe.contentWindow.addEventListener("focus", iframe.contentWindow.selectPlayer);
    iframe.contentWindow.addEventListener("blur", () => active(false));
    iframe.contentDocument.addEventListener("visibilitychange", () => {
        active(!iframe.contentDocument.hidden && iframe.contentDocument.hasFocus());
    });
    const adapter = await Promise.race([
        iframe.contentWindow.boot(roms, { ...coreOptions, sameboy_audio_output: `Game Boy #${audioPlayer + 1}` }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Core startup timed out")), 45000))
    ]);
    return { iframe, adapter };
}

export async function makeManifest(roms, core = "sameboy") {
    const profile = linkCore(core, roms.length);
    const response = await fetch(`../data/cores/reports/${profile.core}.json`, { cache: "no-store" });
    if (!response.ok) throw new Error("Core build report is missing");
    const build = await response.json();
    const synchronizedOptions = { ...profile.options };
    delete synchronizedOptions[profile.audioOption];
    return { protocol: PROTOCOL, core: profile.core, build: build.buildStart,
        roms: await Promise.all(roms.map(sha256)), options: synchronizedOptions,
        timing: { inputDelay: 2, maxPrediction: 12 } };
}

export function batterySave(adapter, session, player) {
    return confirmedMemory(adapter, session, player ? 768 : 256);
}

export function downloadBatterySave(adapter, session, player, filename) {
    const url = URL.createObjectURL(new Blob([batterySave(adapter, session, player)]));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

if (document.getElementById("local")) {
    const $ = id => document.getElementById(id);
    let player, connection, session, ticker, role;
    const status = (text, error = false) => { $("status").textContent = text; $("status").classList.toggle("error", error); };
    const stop = () => {
        clearInterval(ticker);
        if (session) session.stopped = true;
        const active = connection;
        connection = null;
        if (active) active.close();
        $("stop").disabled = true;
    };
    const fail = error => {
        stop();
        status(error.message, true);
        for (const id of ["local", "host", "join"]) $(id).disabled = false;
    };
    async function readRoms() {
        const files = [$("rom1").files[0], $("rom2").files[0]];
        if (files.some(Boolean) && !files.every(Boolean)) throw new Error("Choose both cartridges, or leave both empty for the test.");
        const bytes = await Promise.all(files[0]
            ? files.map(file => file.arrayBuffer().then(buffer => new Uint8Array(buffer)))
            : ["fixtures/link-1.gb", "fixtures/link-2.gbc"].map(async url => {
                const response = await fetch(url);
                if (!response.ok) throw new Error("The test cartridge is missing");
                return new Uint8Array(await response.arrayBuffer());
            }));
        if (bytes.some(rom => rom.length < 0x150 || rom.length > 8 * 1024 * 1024)) throw new Error("Use uncompressed GB/GBC cartridges.");
        return bytes;
    }
    function run(network) {
        let next = performance.now();
        let lastStatus = 0;
        ticker = setInterval(() => {
            const now = performance.now();
            // A suspended tab pauses at the prediction limit; never replay minutes at once.
            if (now - next > 200) next = now;
            if (now < next) return;
            const buttons = player.iframe.contentWindow.localButtons;
            if (network) {
                session.tick(buttons);
                if (session.stopped) return;
            } else player.adapter.step(buttons, player.iframe.contentWindow.secondButtons);
            next += 1000 / 59.7275;
            if (network && now - lastStatus > 500) {
                lastStatus = now;
                status(`Connected · player ${role + 1} · frame ${session.frame} · ${session.stats.rollbacks} rollbacks · ${session.stats.checks} matching checkpoints`);
            }
        }, 4);
        player.iframe.contentWindow.focus();
    }
    async function prepare(mode) {
        stop();
        $("screen").replaceChildren();
        session = connection = null;
        $("signaling").hidden = mode === "local";
        for (const id of ["local", "host", "join"]) $(id).disabled = true;
        $("stop").disabled = false;
        try {
            status("Loading two cartridges…");
            const roms = await readRoms();
            const manifest = await makeManifest(roms);
            player = await bootPlayer($("screen"), roms, mode === "join" ? 1 : 0);
            if (mode !== "join") {
                for (let i = 0; i < 2; i++) {
                    const save = $("save" + (i + 1)).files[0];
                    if (save) player.adapter.loadMemory(i ? 768 : 256, new Uint8Array(await save.arrayBuffer()));
                }
            }
            for (let i = 0; i < 2; i++) $("export" + (i + 1)).disabled = !player.adapter.memory(i ? 768 : 256).length;
            if (mode === "local") {
                // EJS normally binds only one keyboard. Keep a second set independent.
                const keys = { KeyS: 5, KeyW: 4, KeyA: 6, KeyD: 7, KeyG: 0, KeyH: 8, KeyT: 2, KeyY: 3 };
                for (const event of ["keydown", "keyup"]) player.iframe.contentWindow.addEventListener(event, e => {
                    if (!(e.code in keys)) return;
                    e.preventDefault();
                    const win = player.iframe.contentWindow;
                    if (event === "keydown") win.secondButtons |= 1 << keys[e.code];
                    else win.secondButtons &= ~(1 << keys[e.code]);
                }, true);
                status("Local cable connected. Both cartridges run on this computer.");
                run(false);
                return;
            }
            role = mode === "host" ? 0 : 1;
            const iceServers = JSON.parse($("ice").value);
            if (!Array.isArray(iceServers)) throw new Error("ICE servers must be a JSON array");
            connection = new RTCPeerConnection({ iceServers });
            const activeConnection = connection;
            const peerError = error => { if (connection === activeConnection) fail(error); };
            const attach = channel => {
                connectSession(player.adapter, channel, manifest, role, peerError)
                    .then(value => {
                        if (connection !== activeConnection) return;
                        session = value;
                        $("signaling").hidden = true;
                        run(true);
                    }).catch(peerError);
            };
            if (role === 0) {
                attach(connection.createDataChannel("ejs-input-v1", { ordered: true }));
                await connection.setLocalDescription(await connection.createOffer());
                $("outgoing").value = await gatherDescription(connection);
                $("instructions").textContent = "Send your text to player 2, then paste their reply above.";
            } else {
                connection.ondatachannel = event => attach(event.channel);
                $("outgoing").value = "";
                $("instructions").textContent = "Paste player 1's text above. Send the generated reply back to player 1.";
            }
            status("Waiting for the other player’s connection text.");
        } catch (error) {
            fail(error);
            for (const id of ["local", "host", "join"]) $(id).disabled = false;
        }
    }
    for (const mode of ["local", "host", "join"]) $(mode).onclick = () => prepare(mode);
    $("stop").onclick = () => {
        stop();
        status("Disconnected. You can download both battery saves or start a new session.");
        for (const id of ["local", "host", "join"]) $(id).disabled = false;
    };
    $("accept").onclick = async () => {
        try {
            if (!connection) throw new Error("Choose Host or Join first");
            const text = $("incoming").value;
            if (text.length > 65536) throw new Error("Connection text is too long");
            const description = JSON.parse(text);
            if (description.type !== (role ? "offer" : "answer")) throw new Error("Wrong connection text type");
            await connection.setRemoteDescription(description);
            if (role === 1) {
                await connection.setLocalDescription(await connection.createAnswer());
                $("outgoing").value = await gatherDescription(connection);
                status("Send the reply to player 1. Waiting for connection…");
            }
        } catch (error) { fail(error); }
    };
    $("copy").onclick = async () => {
        try { await navigator.clipboard.writeText($("outgoing").value); }
        catch { $("outgoing").focus(); $("outgoing").select(); }
    };
    for (let i = 0; i < 2; i++) $("export" + (i + 1)).onclick = () => {
        try { downloadBatterySave(player.adapter, session, i, `player-${i + 1}.srm`); }
        catch (error) { fail(error); }
    };
    window.addEventListener("pagehide", stop);
}
