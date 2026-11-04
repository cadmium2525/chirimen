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

export const sfx = {
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
