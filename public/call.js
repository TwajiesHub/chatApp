export const qualities = {
  low: { width: 320, height: 180, fps: 10, bitrate: 120000 },
  medium: { width: 640, height: 360, fps: 15, bitrate: 350000 },
  high: { width: 1280, height: 720, fps: 24, bitrate: 900000 },
};
// Budget includes 32 kbps audio each way and 20% protocol/transport overhead.
export const estimate = (q, video) =>
  Math.ceil(
    ((((video ? qualities[q].bitrate : 0) + 32000) * 2 * 600) / 8 / 1000000) *
      1.2,
  );
const $ = (s) => document.querySelector(s);
export class StudyCall {
  constructor({ send, lowData, notify }) {
    Object.assign(this, { send, lowData, notify });
    this.peers = new Map();
    this.active = false;
    this.video = false;
    this.quality = "low";
    this.generation = 0;
  }
  async join(quality, video) {
    if (this.active) throw Error("You are already in a call.");
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
      throw Error(
        "Calls require HTTPS (or localhost) and a browser with WebRTC.",
      );
    this.quality = this.lowData() ? "low" : quality;
    this.video = video;
    const q = qualities[this.quality];
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
        video: video
          ? {
              width: { ideal: q.width },
              height: { ideal: q.height },
              frameRate: { ideal: q.fps, max: q.fps },
            }
          : false,
      });
    } catch (err) {
      throw Error(
        err.name === "NotAllowedError"
          ? "Camera or microphone permission was denied. Allow access in your browser and try again."
          : "Could not access camera/microphone. Check device availability and permissions.",
      );
    }
    this.stream = stream;
    this.active = true;
    this.generation++;
    $("#local-video").srcObject = stream;
    $("#call-panel").hidden = false;
    $("#call-status").textContent = "Waiting for a classmate…";
    $("#toggle-video").textContent = video ? "Voice only" : "Enable video";
    $("#toggle-mic").textContent = "Mute mic";
    $("#live-quality").value = this.quality;
    try {
      this.send({ type: "join-call" });
    } catch (err) {
      this.leave(false);
      throw err;
    }
    this.interval = setInterval(() => this.adapt(), 3000);
  }
  async peer(id, name, offer = false) {
    if (this.peers.has(id)) return this.peers.get(id);
    if (this.peers.size >= 3) return null;
    const pc = new RTCPeerConnection({
      iceServers: this.config?.iceServers || [
        { urls: "stun:stun.l.google.com:19302" },
      ],
    });
    const p = {
      pc,
      id,
      name,
      candidates: [],
      last: new Map(),
      current: qualities[this.quality].bitrate,
      healthy: 0,
    };
    this.peers.set(id, p);
    for (const track of this.stream.getAudioTracks())
      pc.addTrack(track, this.stream);
    const vt = this.stream.getVideoTracks()[0];
    if (vt) pc.addTrack(vt, this.stream);
    else pc.addTransceiver("video", { direction: "sendrecv" });
    pc.onicecandidate = (e) => {
      if (e.candidate && this.active) {
        try {
          this.send({
            type: "signal",
            to: id,
            signal: { candidate: e.candidate },
          });
        } catch {}
      }
    };
    pc.ontrack = (e) => {
      let tile = document.getElementById("peer-" + id);
      if (!tile) {
        tile = document.createElement("div");
        tile.className = "video-tile";
        tile.id = "peer-" + id;
        const video = document.createElement("video");
        video.autoplay = true;
        video.playsInline = true;
        const label = document.createElement("span");
        label.textContent = name;
        tile.append(video, label);
        $("#video-grid").append(tile);
      }
      let stream = tile.querySelector("video").srcObject;
      if (!stream) {
        stream = new MediaStream();
        tile.querySelector("video").srcObject = stream;
      }
      stream.addTrack(e.track);
      tile
        .querySelector("video")
        .play()
        .catch(() => this.notify("Tap the remote video to enable sound."));
      tile.onclick = () => tile.querySelector("video").play();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected")
        $("#call-status").textContent =
          `${this.peers.size + 1} people · connected`;
      if (pc.connectionState === "failed") {
        this.notify(
          "A call connection failed. Leave and rejoin; a TURN relay may be needed.",
        );
        this.remove(id);
      }
      if (pc.connectionState === "disconnected")
        $("#call-status").textContent =
          "Connection interrupted · trying to recover…";
    };
    if (offer) {
      await pc.setLocalDescription(await pc.createOffer());
      this.send({
        type: "signal",
        to: id,
        signal: { description: pc.localDescription },
      });
    }
    return p;
  }
  async handle(m) {
    if (!this.active) return;
    try {
      if (m.type === "call-full") {
        this.notify("This call already has 4 people. Try again later.");
        this.leave();
      } else if (m.type === "peers") {
        for (const p of m.peers) await this.peer(p.peer, p.name, true);
      } else if (m.type === "peer-left") {
        this.remove(m.peer);
      } else if (m.type === "signal") {
        const p = await this.peer(m.from, m.name);
        if (!p) return;
        const s = m.signal;
        if (s.description) {
          await p.pc.setRemoteDescription(s.description);
          for (const c of p.candidates) await p.pc.addIceCandidate(c);
          p.candidates = [];
          if (s.description.type === "offer") {
            await p.pc.setLocalDescription(await p.pc.createAnswer());
            this.send({
              type: "signal",
              to: m.from,
              signal: { description: p.pc.localDescription },
            });
          }
          await this.cap(p, p.current);
        } else if (s.candidate) {
          if (p.pc.remoteDescription) await p.pc.addIceCandidate(s.candidate);
          else p.candidates.push(s.candidate);
        }
      }
    } catch (err) {
      this.notify("Call negotiation failed. Leave and rejoin the room.");
      console.warn("WebRTC negotiation:", err.name);
    }
  }
  async cap(p, bitrate) {
    for (const sender of p.pc.getSenders()) {
      if (!sender.track) continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      for (const e of params.encodings) {
        e.maxBitrate = sender.track.kind === "video" ? bitrate : 24000;
        if (sender.track.kind === "video")
          e.maxFramerate = qualities[this.quality].fps;
      }
      try {
        await sender.setParameters(params);
      } catch {
        /* Some browsers apply bitrate limits only after negotiation. Retry on stats tick. */
      }
    }
  }
  async setQuality(q) {
    this.quality = this.lowData() ? "low" : q;
    $("#live-quality").value = this.quality;
    const quality = qualities[this.quality];
    const track = this.stream?.getVideoTracks()[0];
    if (track)
      try {
        await track.applyConstraints({
          width: { ideal: quality.width },
          height: { ideal: quality.height },
          frameRate: { ideal: quality.fps, max: quality.fps },
        });
      } catch {
        this.notify(
          "Camera could not change resolution; bitrate limits still apply.",
        );
      }
    for (const p of this.peers.values()) {
      p.current = quality.bitrate;
      p.healthy = 0;
      await this.cap(p, p.current);
    }
  }
  async adapt() {
    if (!this.active || this.adapting) return;
    this.adapting = true;
    let bitrate = 0;
    let reduced = false;
    try {
      for (const p of this.peers.values()) {
        const stats = await p.pc.getStats();
        let bad = false;
        stats.forEach((r) => {
          if (r.type === "outbound-rtp" || r.type === "inbound-rtp") {
            const bytes = r.bytesSent ?? r.bytesReceived;
            const old = p.last.get(r.id);
            if (old && r.timestamp > old.timestamp && bytes >= old.bytes)
              bitrate +=
                ((bytes - old.bytes) * 8) / (r.timestamp - old.timestamp);
            p.last.set(r.id, { bytes, timestamp: r.timestamp });
          }
          if (
            r.type === "remote-inbound-rtp" &&
            (r.fractionLost > 0.06 || r.roundTripTime > 0.5)
          )
            bad = true;
          if (
            r.type === "candidate-pair" &&
            r.state === "succeeded" &&
            r.availableOutgoingBitrate &&
            r.availableOutgoingBitrate < p.current * 1.3
          )
            bad = true;
          if (
            r.type === "outbound-rtp" &&
            r.qualityLimitationReason === "bandwidth"
          )
            bad = true;
        });
        const max = qualities[this.lowData() ? "low" : this.quality].bitrate;
        if (bad) {
          p.current = Math.max(40000, Math.round(p.current * 0.7));
          p.healthy = 0;
        } else if (++p.healthy >= 5) {
          p.current = Math.min(max, Math.round(p.current * 1.15));
          p.healthy = 0;
        }
        p.current = Math.min(p.current, max);
        reduced ||= p.current < max;
        await this.cap(p, p.current);
      }
      if (this.active) {
        $("#call-bitrate").textContent = Math.round(bitrate) + " kbps · total";
        $("#call-adaptation").textContent = reduced
          ? "Network is busy. Video bitrate reduced automatically."
          : "Adaptive bitrate on · audio prioritised · quality is a ceiling";
      }
    } catch {
      /* A peer may leave during a stats sample. */
    } finally {
      this.adapting = false;
    }
  }
  toggleMic() {
    const track = this.stream?.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      $("#toggle-mic").textContent = track.enabled ? "Mute mic" : "Unmute";
    }
  }
  async toggleVideo() {
    if (!this.active) return;
    if (this.video) {
      for (const p of this.peers.values()) {
        const sender = p.pc.getSenders().find((s) => s.track?.kind === "video");
        if (sender) await sender.replaceTrack(null);
      }
      for (const track of this.stream.getVideoTracks()) {
        track.stop();
        this.stream.removeTrack(track);
      }
      this.video = false;
      $("#toggle-video").textContent = "Enable video";
      return;
    }
    if (
      !confirm(
        `Enable video? About ${estimate(this.quality, true)} MB per 10 minutes per other person at this quality.`,
      )
    )
      return;
    const generation = this.generation;
    let stream;
    try {
      const q = qualities[this.quality];
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: q.width },
          height: { ideal: q.height },
          frameRate: { ideal: q.fps, max: q.fps },
        },
        audio: false,
      });
      if (!this.active || generation !== this.generation) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const track = stream.getVideoTracks()[0];
      this.stream.addTrack(track);
      for (const p of this.peers.values()) {
        const transceiver = p.pc
          .getTransceivers()
          .find((t) => t.receiver.track.kind === "video");
        if (transceiver) await transceiver.sender.replaceTrack(track);
        await this.cap(p, p.current);
      }
      this.video = true;
      $("#local-video").srcObject = this.stream;
      $("#toggle-video").textContent = "Voice only";
    } catch {
      stream?.getTracks().forEach((t) => t.stop());
      this.notify("Camera unavailable. Your voice call can continue.");
    }
  }
  remove(id) {
    const p = this.peers.get(id);
    if (p) {
      p.pc.close();
      this.peers.delete(id);
    }
    document.getElementById("peer-" + id)?.remove();
    if (this.active)
      $("#call-status").textContent = this.peers.size
        ? `${this.peers.size + 1} people in call`
        : "Waiting for a classmate…";
  }
  leave(signal = true) {
    if (signal && this.active)
      try {
        this.send({ type: "leave-call" });
      } catch {}
    this.active = false;
    this.generation++;
    clearInterval(this.interval);
    for (const id of [...this.peers.keys()]) this.remove(id);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    $("#local-video").srcObject = null;
    $("#call-panel").hidden = true;
  }
}
