// Thin WebSocket client. One instance per connection; messages are plain JSON
// dispatched by their `t` field.

export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.onOpen = null;
    this.onClose = null;
    this.connected = false;
    this.bytesIn = 0;    // for net_graph
    this.bytesOut = 0;
    this.lastMsgAt = performance.now();   // connection-problem warning
  }

  on(type, fn) { this.handlers.set(type, fn); }

  connect(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      try { this.ws = new WebSocket(url); }
      catch (e) { reject(e); return; }

      // Resolve as soon as the socket OPENS. The caller then sends `join`;
      // `welcome` arrives in reply and is dispatched through the handlers like
      // any other message. (Resolving on `welcome` here would deadlock: the
      // server only sends it after receiving `join`.)
      this.ws.onopen = () => {
        this.connected = true;
        this.lastMsgAt = performance.now();
        if (!settled) { settled = true; resolve(); }
        if (this.onOpen) this.onOpen();
      };
      this.ws.onerror = () => { if (!settled) { settled = true; reject(new Error('connection failed')); } };
      this.ws.onclose = () => {
        this.connected = false;
        if (this.onClose) this.onClose();
        if (!settled) { settled = true; reject(new Error('connection closed')); }
      };
      this.ws.onmessage = (ev) => {
        let msg;
        this.bytesIn += ev.data.length;
        this.lastMsgAt = performance.now();
        try { msg = JSON.parse(ev.data); } catch { return; }
        // debug counters for automated testing
        window.__msgCount = (window.__msgCount || 0) + 1;
        window.__lastMsg = msg.t;
        if (this.tap) this.tap(msg);          // demo recording
        const h = this.handlers.get(msg.t);
        if (h) h(msg);
      };
    });
  }

  // demo playback: deliver a recorded message as if it had arrived
  inject(msg) { const h = this.handlers.get(msg.t); if (h) h(msg); }

  send(obj) {
    if (this.fake) return;               // playing a demo: nothing goes out
    if (this.ws && this.ws.readyState === 1) { const d = JSON.stringify(obj); this.bytesOut += d.length; this.ws.send(d); }
  }

  close() { if (this.ws) this.ws.close(); }
}
