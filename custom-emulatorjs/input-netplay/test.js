import { bootPlayer, makeManifest, downloadBatterySave } from "./lab.js?v=20261021.10";
import { connectSession, gatherDescription, stateHash } from "../data/src/input-netplay.js?v=20261021.10";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const pattern = (player, frame) => (Math.floor(frame / (player ? 13 : 17)) % 2 ? 256 : 0);
const stage = message => { document.getElementById("status").textContent = message; };
const differences = (a, b) => {
    const result = [];
    let count = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) {
        count++;
        if (result.length < 50) result.push([i, a[i], b[i]]);
    }
    return { count, first: result };
};
window.testProgress = [];
async function channels() {
    const connections = [new RTCPeerConnection({ iceServers: [] }), new RTCPeerConnection({ iceServers: [] })];
    const remote = new Promise(resolve => { connections[1].ondatachannel = event => resolve(event.channel); });
    const first = connections[0].createDataChannel("ejs-input-test", { ordered: true });
    await connections[0].setLocalDescription(await connections[0].createOffer());
    await connections[1].setRemoteDescription(JSON.parse(await gatherDescription(connections[0])));
    await connections[1].setLocalDescription(await connections[1].createAnswer());
    await connections[0].setRemoteDescription(JSON.parse(await gatherDescription(connections[1])));
    return { connections, channels: [first, await remote] };
}

async function startLiveDemo(players, manifest) {
    stage("Connecting the two peers…");
    const live = await channels();
    let timer;
    const stop = () => {
        clearInterval(timer);
        live.connections.forEach(pc => pc.close());
    };
    try {
        const sessions = await Promise.all(players.map(({ adapter }, player) => connectSession(adapter, live.channels[player], manifest, player,
            error => { stage(error.message); clearInterval(timer); })));
        let next = performance.now();
        stage("Connected · click Peer 1 or Peer 2 to play");
        timer = setInterval(() => {
            const now = performance.now();
            if (now < next) return;
            if (now - next > 200) next = now;
            next += 1000 / 59.7275;
            sessions.forEach((session, player) => session.tick(players[player].iframe.contentWindow.localButtons));
            if (sessions[0].frame % 30 === 0) {
                stage(`Live WebRTC link · frame ${sessions[0].frame} · ${sessions[0].stats.checks} matching checkpoints · click a peer to play`);
            }
        }, 4);
        window.liveDemo = { ...live, sessions, timer };
        window.addEventListener("pagehide", stop, { once: true });
    } catch (error) {
        stop();
        throw error;
    }
}

window.netplayTestPromise = (async () => {
    let network;
    try {
        const params = new URLSearchParams(location.search);
        const live = params.has("live");
        let files, saves;
        if (live && params.has("cartridges")) {
            const form = document.getElementById("cartridges");
            form.hidden = false;
            stage("Choose two cartridges to start.");
            await new Promise(resolve => form.addEventListener("submit", event => { event.preventDefault(); resolve(); }, { once: true }));
            files = [1, 2].map(i => document.getElementById(`rom${i}`).files[0]);
            saves = [1, 2].map(i => document.getElementById(`save${i}`).files[0]);
            form.hidden = true;
        }
        const roms = await Promise.all(files
            ? files.map(async file => new Uint8Array(await file.arrayBuffer()))
            : ["fixtures/link-1.gb", "fixtures/link-2.gbc"].map(async url => new Uint8Array(await (await fetch(url)).arrayBuffer())));
        assert(roms.every(rom => rom.length >= 0x150 && rom.length <= 8 * 1024 * 1024), "Use uncompressed GB/GBC cartridges.");
        const manifest = await makeManifest(roms);
        if (!live) assert(manifest.roms[0] !== manifest.roms[1], "Test requires two different cartridges");
        const players = await Promise.all([0, 1].map(player => {
            const panel = document.createElement("section");
            const label = document.createElement("h2");
            label.textContent = `Peer ${player + 1} · ${files ? files[player].name.replace(/\.(gb|gbc)$/i, "") : `controls Game Boy ${player + 1}`}`;
            panel.append(label);
            document.getElementById("peers").append(panel);
            return bootPlayer(panel, roms, player);
        }));
        window.testPlayers = players;
        const adapters = players.map(p => p.adapter);
        players.forEach(p => p.iframe.contentWindow.EJS_emulator.setVolume(0));
        for (let i = 0; i < 2; i++) {
            if (saves?.[i]) adapters[0].loadMemory(i ? 768 : 256, new Uint8Array(await saves[i].arrayBuffer()));
        }
        stage("Booting the two cartridges…");
        for (let f = 0; f < 300; f++) adapters[0].step(0, 0, false);
        const initial = adapters[0].save();
        window.testInitial = initial;
        if (live) {
            document.title = "SameBoy link demo";
            document.querySelector("h1").textContent = "SameBoy link demo";
            document.getElementById("result").hidden = true;
            await startLiveDemo(players, manifest);
            const exports = document.getElementById("saves");
            exports.hidden = false;
            for (let i = 0; i < 2; i++) {
                const button = document.getElementById(`export${i + 1}`);
                button.disabled = !adapters[0].memory(i ? 768 : 256).length;
                button.onclick = () => {
                    try {
                        const name = files?.[i].name.replace(/\.(gb|gbc)$/i, "") || `player-${i + 1}`;
                        downloadBatterySave(adapters[0], window.liveDemo.sessions[0], i, name + ".srm");
                    } catch (error) { stage(error.message); }
                };
            }
            return { passed: true, mode: "live", liveDemoRunning: true };
        }
        const frames = 360;
        stage("Computing the offline reference…");
        window.referenceStates = new Map();
        for (let f = 0; f < frames; f++) {
            adapters[0].step(f < 2 ? 0 : pattern(0, f - 2), f < 2 ? 0 : pattern(1, f - 2), false);
            if ((f + 1) % 60 === 0) window.referenceStates.set(f + 1, adapters[0].save());
        }
        const reference = adapters[0].save();
        const expectedMemory = [1282, 1538].map(id => Array.from(adapters[0].memory(id).slice(0, 8)));
        window.testProgress.push({ stage: "reference", hash: stateHash(reference), memory: expectedMemory });
        adapters[0].load(initial);
        assert(!differences(initial, adapters[0].save()).count, "Restoring a snapshot changed its contents");
        for (let p = 0; p < 2; p++) {
            adapters[p].load(initial);
            for (let f = 0; f < 60; f++) adapters[p].step(f < 2 ? 0 : pattern(0, f - 2), f < 2 ? 0 : pattern(1, f - 2), false);
            const diff = differences(window.referenceStates.get(60), adapters[p].save());
            window.testProgress.push({ stage: "determinism", player: p, differences: diff });
            assert(!diff.count, `Core ${p} did not reproduce the same state after restore`);
            adapters[p].load(initial);
        }
        stage("Connecting real WebRTC peers…");
        network = await channels();
        const sent = [0, 0];
        // Inject 80–140 ms one-way delay and reordering before WebRTC sends.
        network.channels.forEach((channel, player) => {
            const send = channel.send.bind(channel);
            channel.send = data => {
                const packet = typeof data === "string" ? JSON.parse(data) : null;
                if (packet?.t === "input" || packet?.t === "hash") {
                    sent[player]++;
                    setTimeout(() => { if (channel.readyState === "open") send(data); }, 80 + (packet.f * 13 + player * 7) % 61);
                } else send(data);
            };
        });
        const errors = [];
        const sessions = await Promise.all(adapters.map((adapter, player) => connectSession(adapter, network.channels[player], manifest, player, error => errors.push(error.message))));
        window.testSessions = sessions;
        stage("Running 360 frames with 80–140 ms one-way delay…");
        const start = performance.now();
        while (sessions.some(s => s.frame < frames)) {
            assert(!errors.length, errors.join("; "));
            assert(performance.now() - start < 20000, "Network simulation timed out");
            sessions.forEach((session, player) => { if (session.frame < frames) session.tick(pattern(player, session.frame)); });
            await sleep(1000 / 59.7275);
        }
        await sleep(300);
        assert(!errors.length, errors.join("; "));
        const hashes = adapters.map(adapter => stateHash(adapter.save()));
        assert(hashes.every(hash => hash === stateHash(reference)), `States differ: ${hashes} / reference ${stateHash(reference)}`);
        assert(adapters.every(adapter => !differences(reference, adapter.save()).count), "Full snapshot bytes differ from the offline reference");
        const memory = adapters.map(adapter => [1282, 1538].map(id => Array.from(adapter.memory(id).slice(0, 8))));
        for (const peer of memory) {
            assert(peer.every(ram => ram[4] === 0xa5 && ram[1] > 10), `Cartridges did not exchange serial data: ${JSON.stringify(peer)}`);
            assert((peer[0][0] & 0xf0) === 0xb0 && (peer[1][0] & 0xf0) === 0xa0, "Wrong cable data received");
        }
        assert(sessions.every(s => s.stats.rollbacks > 0 && s.stats.checks === 6), "Rollback or state verification did not run");
        const stats = await network.connections[0].getStats();
        assert(!Array.from(stats.values()).some(s => ["outbound-rtp", "inbound-rtp"].includes(s.type)), "Unexpected media streaming");
        const result = { passed: true, frames, oneWayDelayMs: [80, 140], romHashes: manifest.roms,
            stateHashes: hashes, referenceHash: stateHash(reference), snapshotsBytes: initial.length,
            sent, peers: sessions.map(s => s.stats), serialMemory: memory, mediaStreams: 0 };
        network.connections[0].close();
        await sleep(150);
        assert(sessions[1].stopped, "Disconnect did not stop the remote peer");
        result.disconnectStopsPeer = true;
        const mismatch = await channels();
        const rejected = await Promise.allSettled(adapters.map((adapter, player) => connectSession(adapter, mismatch.channels[player],
            player ? { ...manifest, roms: ["different-rom", manifest.roms[1]] } : manifest, player)));
        mismatch.connections.forEach(pc => pc.close());
        assert(rejected.every(r => r.status === "rejected"), "Mismatched cartridges were accepted");
        result.mismatchedRomsRejected = true;
        stage("PASS · linked cartridges and both network peers match the offline reference.");
        return result;
    } catch (error) {
        stage("FAIL · " + error.message);
        if (window.testSessions) {
            window.testProgress.push({ stage: "mismatch", peers: window.testSessions.map(s => ({ frame: s.frame, stats: s.stats,
                hashes: Array.from(s.hashes), difference: s.snapshots.has(60) ? differences(window.referenceStates.get(60), s.snapshots.get(60)) : null })) });
        }
        return { passed: false, error: error.message, stack: error.stack, progress: window.testProgress };
    } finally {
        network?.connections.forEach(pc => pc.close());
    }
})().then(result => {
    window.netplayTestResult = result;
    document.getElementById("result").textContent = JSON.stringify(result, null, 2);
    return result;
});
