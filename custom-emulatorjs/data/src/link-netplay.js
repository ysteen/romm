import {
  confirmedMemory,
  connectSession,
  connectGroupSession,
  PeerDisconnectedError,
} from "./input-netplay.js?v=20261021.10";
import { importBattery, linkCore } from "./link-core.js?v=20261021.10";

// Room discovery and signaling stay in Netplay; only its WebRTC payload changes.
export class LinkNetplay {
  constructor(
    netplay,
    adapter,
    {
      manifest,
      gameId,
      save = null,
      iceTransportPolicy = "all",
      onStatus = () => {},
      onSolo = null,
    },
  ) {
    Object.assign(this, {
      netplay,
      adapter,
      manifest,
      gameId,
      save,
      iceTransportPolicy,
      onStatus,
      onSolo,
    });
    this.profile =
      adapter.profile ?? linkCore(manifest.core, manifest.roms.length);
    this.maxPlayers = manifest.roms.length;
    this.channels = new Map();
    this.initial = adapter.save();
    this.session = null;
    this.role = null;
    this.status = "ready";
    this.timer = null;
    this.generation = 0;
    this.destroyed = false;
    netplay.inputSession = this;
  }

  publish(status, error) {
    this.status = status;
    this.onStatus({ status, player: this.role, error: error?.message });
  }

  prepare(owner) {
    this.stop(false);
    const slot = Object.keys(this.netplay.players ?? {}).indexOf(
      this.netplay.playerID,
    );
    this.role = slot >= 0 ? slot : owner ? 0 : 1;
    this.hadPeer = Object.keys(this.netplay.players ?? {}).length > 1;
    this.adapter.load(this.initial);
    const bytes = this.save;
    if (bytes) importBattery(this.adapter, this.profile, this.role, bytes);
    this.netplay.emu.gameManager.setVariable(
      this.profile.linkOption,
      "enabled",
    );
    this.netplay.emu.gameManager.setVariable(
      this.profile.audioOption,
      this.profile.audio[this.role],
    );
    this.publish("waiting");
  }

  joined() {
    this.publish("waiting");
  }

  connectPeers(users) {
    if (
      !users[this.netplay.playerID]?.link_ready ||
      Object.keys(users).length !== this.maxPlayers
    )
      return;
    Object.values(users).forEach((user, slot) => {
      if (
        slot > this.role &&
        user.link_ready &&
        !this.netplay.peerConnections[user.socketId]
      )
        this.createPeerConnection(user.socketId);
    });
  }

  createPeerConnection(peerId) {
    const netplay = this.netplay;
    const peerRole = Object.values(netplay.players).findIndex(
      (user) => user.socketId === peerId,
    );
    if (peerRole < 0 || peerRole === this.role)
      throw new Error("Unknown link participant");
    const generation = this.generation;
    const pc = new RTCPeerConnection({
      iceServers: netplay.iceServers,
      iceTransportPolicy: this.iceTransportPolicy,
    });
    const peer = {
      pc,
      dataChannel: null,
      usingRelay: false,
      iceCandidateQueue: [],
    };
    netplay.peerConnections[peerId] = peer;
    const current = () =>
      generation === this.generation &&
      netplay.peerConnections[peerId] === peer;
    const fail = (error) => {
      if (!current()) return;
      if (error instanceof PeerDisconnectedError) netplay.leaveRoom();
      else this.fail(error);
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && current())
        netplay.socket?.emit("webrtc-signal", {
          target: peerId,
          candidate,
        });
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(pc.connectionState))
        fail(new PeerDisconnectedError("Peer connection closed"));
    };
    const attach = (channel) => {
      if (!current() || peer.dataChannel) {
        channel.close();
        return;
      }
      peer.dataChannel = channel;
      this.publish("connecting");
      this.channels.set(peerRole, channel);
      channel.binaryType = "arraybuffer";
      channel.linkMessages = [];
      let queuedBytes = 0;
      channel.onmessage = (event) => {
        queuedBytes +=
          typeof event.data === "string"
            ? event.data.length
            : event.data.byteLength;
        if (queuedBytes > 16 * 1024 * 1024) {
          fail(new Error("Peer setup queue is full"));
          return;
        }
        channel.linkMessages.push(event);
      };
      if (this.channels.size !== this.maxPlayers - 1) return;
      const setup =
        this.maxPlayers === 2
          ? connectSession(
              this.adapter,
              channel,
              this.manifest,
              this.role,
              fail,
            )
          : connectGroupSession(
              this.adapter,
              this.channels,
              this.manifest,
              this.role,
              fail,
            );
      setup
        .then((session) => {
          if (!current()) {
            session.stopped = true;
            return;
          }
          this.session = session;
          netplay.webRtcReady = true;
          this.publish("connected");
          this.run(() => session.tick(window.localButtons || 0));
        })
        .catch(fail);
    };
    if (this.role < peerRole) {
      attach(pc.createDataChannel("ejs-input-v1", { ordered: true }));
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          if (current())
            netplay.socket.emit("webrtc-signal", {
              target: peerId,
              offer: pc.localDescription,
            });
        })
        .catch(fail);
    } else pc.ondatachannel = ({ channel }) => attach(channel);
    return pc;
  }

  usersUpdated(users) {
    const sockets = new Set(Object.values(users).map((user) => user.socketId));
    this.hadPeer ||= sockets.size > 1;
    if (
      (this.hadPeer && sockets.size !== this.maxPlayers) ||
      Object.keys(this.netplay.peerConnections).some((id) => !sockets.has(id))
    )
      this.netplay.leaveRoom();
  }

  battery() {
    if (this.role === null) return null;
    return confirmedMemory(
      this.adapter,
      this.session,
      this.profile.memoryIds[this.role],
    );
  }

  fail(error) {
    if (this.status === "error") return;
    this.netplay.leaveRoom();
    this.stop(false);
    this.publish("error", error);
  }

  run(step) {
    clearInterval(this.timer);
    let next = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      if (now - next > 200) next = now;
      if (now < next) return;
      try {
        step();
      } catch (error) {
        this.fail(error);
      }
      next += 1000 / 59.7275;
    }, 4);
  }

  stop(resume = true) {
    if (resume && this.status === "solo" && !this.destroyed) return;
    this.generation++;
    this.channels.clear();
    clearInterval(this.timer);
    this.timer = null;
    this.adapter.begin();
    if (this.session) {
      this.session.stopped = true;
      // Discard speculative frames before the two machines diverge.
      const confirmed = this.session.snapshots.get(
        Math.min(this.session.frame, this.session.remoteThrough + 1),
      );
      if (confirmed) this.adapter.load(confirmed);
      this.session = null;
    }
    if (this.role !== null) {
      this.save = this.battery();
      this.netplay.emu.gameManager.setVariable(
        this.profile.linkOption,
        "disabled",
      );
    }
    if (resume && !this.destroyed && this.role !== null) {
      if (this.onSolo) this.onSolo(this.role);
      else
        this.run(() => {
          const buttons = window.localButtons || 0;
          if (this.maxPlayers === 2)
            this.adapter.step(
              this.role === 0 ? buttons : 0,
              this.role === 1 ? buttons : 0,
            );
          else
            this.adapter.stepPlayers(
              Array.from({ length: this.maxPlayers }, (_, p) =>
                p === this.role ? buttons : 0,
              ),
            );
        });
      this.publish("solo");
    } else this.publish("stopped");
  }

  destroy() {
    this.destroyed = true;
    this.stop(false);
    this.netplay.leaveRoom();
  }
}
