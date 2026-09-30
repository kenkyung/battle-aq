// Team voice chat (M18), CS style: hold K (+voicerecord) to talk to your
// team. Peer-to-peer WebRTC audio between human teammates; the game server
// only relays the handshake (`rtc` messages). "Perfect negotiation": either
// side may start, the politer one (higher id) yields on a collision.

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

export class Voice {
  constructor(net, { myId, teammates, onSpeaking }) {
    this.net = net;
    this.myId = myId;           // () => id
    this.teammates = teammates; // () => [human teammate ids]
    this.onSpeaking = onSpeaking || (() => {});
    this.peers = new Map();     // id -> { pc, audio, makingOffer, ignoreOffer }
    this.stream = null;
    this.enabled = true;
    this.volume = 1;
    this.talking = false;
  }

  async mic() {
    if (this.stream) return this.stream;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    for (const t of this.stream.getAudioTracks()) t.enabled = false;
    for (const p of this.peers.values()) for (const t of this.stream.getAudioTracks()) p.pc.addTrack(t, this.stream);
    return this.stream;
  }

  async talk(on) {
    if (!this.enabled || on === this.talking) return;
    this.talking = on;
    if (on) {
      try { await this.mic(); } catch { this.talking = false; this.onSpeaking(this.myId(), false, 'no microphone'); return; }
      this.sync();
    }
    if (this.stream) for (const t of this.stream.getAudioTracks()) t.enabled = this.talking;
    this.net.send({ t: 'talk', on: this.talking });
    this.onSpeaking(this.myId(), this.talking);
  }

  // keep one connection per human teammate
  sync() {
    if (!this.enabled) return;
    const want = new Set(this.teammates());
    for (const id of [...this.peers.keys()]) if (!want.has(id)) this.drop(id);
    for (const id of want) if (!this.peers.has(id)) this.peer(id);
  }

  peer(id) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const audio = new Audio();
    audio.autoplay = true;
    const e = { pc, audio, makingOffer: false, ignoreOffer: false, polite: this.myId() > id };
    this.peers.set(id, e);
    if (this.stream) for (const t of this.stream.getAudioTracks()) pc.addTrack(t, this.stream);
    else pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = (ev) => { audio.srcObject = ev.streams[0] || new MediaStream([ev.track]); audio.volume = this.volume; audio.play().catch(() => {}); };
    pc.onicecandidate = (ev) => { if (ev.candidate) this.net.send({ t: 'rtc', to: id, data: { ice: ev.candidate } }); };
    pc.onnegotiationneeded = async () => {
      try {
        e.makingOffer = true;
        await pc.setLocalDescription();
        this.net.send({ t: 'rtc', to: id, data: { sdp: pc.localDescription } });
      } catch { /* retried on the next change */ } finally { e.makingOffer = false; }
    };
    return e;
  }

  drop(id) {
    const e = this.peers.get(id);
    if (!e) return;
    try { e.pc.close(); } catch { /* closed */ }
    e.audio.srcObject = null;
    this.peers.delete(id);
  }

  async handle(msg) {
    if (!this.enabled) return;
    const e = this.peers.get(msg.from) || this.peer(msg.from);
    const { pc } = e;
    const d = msg.data || {};
    try {
      if (d.sdp) {
        const collision = d.sdp.type === 'offer' && (e.makingOffer || pc.signalingState !== 'stable');
        e.ignoreOffer = !e.polite && collision;
        if (e.ignoreOffer) return;
        await pc.setRemoteDescription(d.sdp);
        if (d.sdp.type === 'offer') {
          await pc.setLocalDescription();
          this.net.send({ t: 'rtc', to: msg.from, data: { sdp: pc.localDescription } });
        }
      } else if (d.ice) {
        try { await pc.addIceCandidate(d.ice); } catch (err) { if (!e.ignoreOffer) throw err; }
      }
    } catch { /* a failed handshake: the next sync retries */ }
  }

  setVolume(v) { this.volume = v; for (const e of this.peers.values()) e.audio.volume = v; }
  setEnabled(on) { this.enabled = on; if (!on) { this.talk(false); for (const id of [...this.peers.keys()]) this.drop(id); } }
  closeAll() { for (const id of [...this.peers.keys()]) this.drop(id); }
}
