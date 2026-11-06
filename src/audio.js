// 効果音（WebAudio で合成。音源ファイル不要）
let ctx = null;
let enabled = true;

export function setSound(on) { enabled = on; }

function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, dur, type = 'sine', vol = 0.15, when = 0, slide = 0) {
  if (!enabled) return;
  const a = ac();
  if (!a) return;
  const t = a.currentTime + when;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

let noiseBuf = null;
/** 砂が流れるような音（フィルターをかけた雑音） */
function noise(dur, vol, freq) {
  if (!enabled) return;
  const a = ac();
  if (!a) return;
  if (!noiseBuf) {
    noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = a.currentTime;
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  src.buffer = noiseBuf;
  f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 0.8;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(a.destination);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.05);
}

export const sfx = {
  slide: (v = 0.5) => noise(0.35 + v * 0.4, 0.015 + v * 0.05, 900 - v * 400),
  unlock: () => ac(),
  pick: () => tone(880, 0.06, 'triangle', 0.08, 0, 1.4),
  scoop: () => { tone(220, 0.12, 'sawtooth', 0.05, 0, 0.6); tone(330, 0.1, 'triangle', 0.05, 0.03); },
  drop: () => tone(520, 0.08, 'triangle', 0.08, 0, 0.6),
  pack: () => { tone(988, 0.08, 'square', 0.06); tone(1319, 0.14, 'square', 0.06, 0.08); },
  buy: () => { tone(660, 0.08, 'triangle', 0.1); tone(880, 0.08, 'triangle', 0.1, 0.08); tone(1100, 0.15, 'triangle', 0.1, 0.16); },
  find: () => { [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.18, 'triangle', 0.1, i * 0.09)); },
  warn: () => { tone(330, 0.18, 'square', 0.07); tone(262, 0.25, 'square', 0.07, 0.18); },
  deny: () => tone(180, 0.12, 'square', 0.05),
};
