const SETTINGS_PATH = "/melonDS DS/wfcsettings.bin";
const QUEUE_BYTES = 256 * 1024;

export class WfcSession {
  constructor(manager, notify = () => {}) {
    this.manager = manager;
    this.notify = notify;
    this.queue = [];
    this.queuedBytes = 0;
    this.closed = false;
  }

  async request(path, method, body, keepalive = false) {
    const cookie = document.cookie
      .split("; ")
      .find((part) => part.startsWith("romm_csrftoken="));
    const response = await fetch(`/api/netplay/wfc/${path}`, {
      method,
      credentials: "same-origin",
      keepalive,
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": decodeURIComponent(
          cookie?.slice("romm_csrftoken=".length) ?? "",
        ),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(
        error.detail || `WFC request failed (${response.status})`,
      );
    }
    return response.status === 204 ? null : response.json();
  }

  async connect(romId) {
    const session = await this.request("sessions", "POST", { rom_id: romId });
    if (this.closed) throw new Error("WFC game was closed");
    this.profile = session.profile;
    if (!/^[0-9a-f]{12}$/.test(this.profile.mac))
      throw new Error("Invalid WFC console identity");
    this.mac = Uint8Array.from(this.profile.mac.match(/../g), (value) =>
      parseInt(value, 16),
    );
    this.lastSettings = this.profile.firmware;
    this.manager.FS.mkdirTree(
      SETTINGS_PATH.slice(0, SETTINGS_PATH.lastIndexOf("/")),
    );
    if (this.profile.firmware)
      this.manager.writeFile(
        SETTINGS_PATH,
        Uint8Array.from(atob(this.profile.firmware), (c) => c.charCodeAt(0)),
      );
    this.manager.Module.rommWfc = this;
    const socket = (this.socket = new WebSocket(session.websocket_url));
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      if (
        bytes.length < 14 ||
        bytes.length > 2048 ||
        this.queuedBytes + bytes.length > QUEUE_BYTES
      )
        return;
      this.queue.push(bytes);
      this.queuedBytes += bytes.length;
    });
    socket.addEventListener("close", () => {
      this.queue.length = 0;
      this.queuedBytes = 0;
      if (!this.closed)
        this.notify("WFC connection closed. Restart the game to reconnect.");
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("WFC connection timed out"));
      }, 10_000);
      const fail = () => {
        clearTimeout(timer);
        reject(new Error("WFC connection failed"));
      };
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener("error", fail, { once: true });
      socket.addEventListener("close", fail, { once: true });
    });
    this.timer = setInterval(() => {
      void this.saveSettings();
    }, 5000);
    this.onPageHide = () => this.close();
    window.addEventListener("pagehide", this.onPageHide, { once: true });
  }

  send(bytes) {
    if (
      this.closed ||
      this.socket?.readyState !== WebSocket.OPEN ||
      bytes.length > 2048 ||
      this.socket.bufferedAmount > QUEUE_BYTES
    )
      return 0;
    this.socket.send(bytes);
    return bytes.length;
  }

  receive() {
    const bytes = this.queue.shift();
    if (bytes) this.queuedBytes -= bytes.length;
    return bytes;
  }

  async saveSettings(keepalive = false) {
    if (this.saving || !this.profile) return;
    let bytes;
    try {
      bytes = this.manager.FS.readFile(SETTINGS_PATH);
    } catch {
      return;
    }
    if (!bytes.length || bytes.length > 4096) return;
    const firmware = btoa(String.fromCharCode(...bytes));
    if (firmware === this.lastSettings) return;
    this.saving = true;
    try {
      await this.request(
        "settings",
        "PUT",
        { firmware, mac: this.profile.mac },
        keepalive,
      );
      this.lastSettings = firmware;
      this.saveError = false;
    } catch {
      if (!this.saveError)
        this.notify(
          "WFC settings could not be saved. Retrying while the game is open.",
        );
      this.saveError = true;
    } finally {
      this.saving = false;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    window.removeEventListener("pagehide", this.onPageHide);
    void this.saveSettings(true);
    this.socket?.close();
    this.queue.length = 0;
    this.queuedBytes = 0;
  }
}
