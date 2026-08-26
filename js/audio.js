// All-chiptune audio from the Web Audio API. No audio files.
// Ocean bed = looped filtered noise; everything else is little synth cues.

let ctx = null, master = null, oceanGain = null, surfGain = null;
let muted = localStorage.getItem("dp_muted") === "1";

function ensure() {
  if (ctx) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.5;
  master.connect(ctx.destination);

  // Two-second noise loop -> lowpass = the ocean.
  const len = 2 * ctx.sampleRate;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf; src.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass"; lp.frequency.value = 380;
  oceanGain = ctx.createGain(); oceanGain.gain.value = 0.10;
  src.connect(lp).connect(oceanGain).connect(master);
  src.start();

  // Second noise path that swells when waves break near the surfer.
  const src2 = ctx.createBufferSource();
  src2.buffer = buf; src2.loop = true; src2.playbackRate.value = 0.7;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass"; bp.frequency.value = 900; bp.Q.value = 0.6;
  surfGain = ctx.createGain(); surfGain.gain.value = 0;
  src2.connect(bp).connect(surfGain).connect(master);
  src2.start();
  return true;
}

export function initOnGesture() { if (ensure() && ctx.state === "suspended") ctx.resume(); }
export function isMuted() { return muted; }
export function toggleMute() {
  muted = !muted;
  localStorage.setItem("dp_muted", muted ? "1" : "0");
  if (master) master.gain.value = muted ? 0 : 0.5;
  return muted;
}

// 0..1: how much whitewater is going off near the player.
export function setSurfLevel(v) {
  if (surfGain) surfGain.gain.setTargetAtTime(Math.min(1, v) * 0.22, ctx.currentTime, 0.4);
}

function tone(freq, t0, dur, type = "square", vol = 0.16, slide = 0) {
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g).connect(master);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

function noiseBurst(t0, dur, freq = 1500, vol = 0.25) {
  if (!ctx) return;
  const len = Math.ceil(dur * ctx.sampleRate);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const s = ctx.createBufferSource(); s.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = freq;
  const g = ctx.createGain(); g.gain.value = vol;
  s.connect(f).connect(g).connect(master);
  s.start(t0);
}

const now = () => (ctx ? ctx.currentTime : 0);

export const sfx = {
  paddle: () => noiseBurst(now(), 0.12, 800, 0.12),
  popup: () => { tone(392, now(), 0.07); tone(587, now() + 0.07, 0.1); },
  pump: () => noiseBurst(now(), 0.08, 1200, 0.07),
  snap: () => { noiseBurst(now(), 0.22, 2400, 0.3); tone(880, now(), 0.08, "square", 0.08, -300); },
  cutback: () => noiseBurst(now(), 0.3, 600, 0.18),
  floater: () => noiseBurst(now(), 0.35, 1800, 0.2),
  barrelTick: () => tone(1245, now(), 0.05, "sine", 0.06),
  section: () => { tone(220, now(), 0.09, "square", 0.12); tone(220, now() + 0.12, 0.09, "square", 0.12); },
  kickout: () => { tone(523, now(), 0.08); tone(659, now() + 0.08, 0.08); tone(784, now() + 0.16, 0.14); },
  wipeout: () => { tone(600, now(), 0.6, "sawtooth", 0.14, -520); noiseBurst(now() + 0.1, 0.5, 500, 0.3); },
  setBell: () => tone(1568, now(), 0.25, "sine", 0.08),
  score: (band) => {
    // band 0..3: bigger score, longer fanfare.
    const seqs = [
      [392, 523],
      [392, 523, 659],
      [523, 659, 784, 1047],
      [523, 659, 784, 1047, 1319, 1568],
    ];
    seqs[Math.min(3, band)].forEach((f, i) => tone(f, now() + i * 0.11, 0.14, "square", 0.14));
  },
};
