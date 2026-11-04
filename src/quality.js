// 画質プリセット（企画書 5章）と詳細設定の上書き、動的解像度
export const PRESETS = {
  low: {
    label: '低画質', pixelRatio: 1, minScale: 0.5, nearRadius: 1.7, perColumn: 6,
    instanceCap: 14000, shadows: false, shadowSize: 512, targetFps: 30, aid: true, distance: 24,
  },
  standard: {
    label: '標準', pixelRatio: 1.5, minScale: 0.6, nearRadius: 2.5, perColumn: 12,
    instanceCap: 40000, shadows: true, shadowSize: 1024, targetFps: 45, aid: false, distance: 34,
  },
  high: {
    label: '高画質', pixelRatio: 2, minScale: 0.75, nearRadius: 3.3, perColumn: 20,
    instanceCap: 100000, shadows: true, shadowSize: 2048, targetFps: 60, aid: false, distance: 48,
  },
};

const DENSITY = { low: 'low', mid: 'standard', high: 'high' };
const DISTANCE = { short: 20, mid: 34, long: 48 };

/** WebGL の GPU 名（取れれば） */
export function gpuName(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch { return ''; }
}

const WEAK_GPU = /(Mali-[2-7]\d{0,2}\b|Mali-G(31|51|52|57)|Adreno \(TM\) [3-5]\d\d|PowerVR|SwiftShader|llvmpipe|Intel.*HD Graphics ?[2-5]\d{2,3}?\b|Intel\(R\) HD Graphics$)/i;

export function autoPreset(isTouch, gpu = '') {
  if (isTouch) return 'low';
  if (WEAK_GPU.test(gpu)) return 'low';
  const cores = navigator.hardwareConcurrency || 4;
  return cores >= 8 ? 'standard' : 'low';
}

/**
 * プリセット＋詳細設定の上書き。
 * settings.qDensity（近景の個体数・範囲）, qShadows, qDistance, qRes（固定解像度倍率）
 */
export function resolvePreset(name, isTouch, settings = {}, gpu = '', autoStep = 0) {
  let key = name === 'auto' ? autoPreset(isTouch, gpu) : name;
  // 自動のとき、重すぎて下げた段数だけ下げる
  const order = ['low', 'standard', 'high'];
  if (name === 'auto' && autoStep) key = order[Math.max(0, order.indexOf(key) - autoStep)];
  const q = { key, ...PRESETS[key] };
  if (settings.qDensity && settings.qDensity !== 'preset') {
    const d = PRESETS[DENSITY[settings.qDensity]];
    Object.assign(q, { nearRadius: d.nearRadius, perColumn: d.perColumn, instanceCap: d.instanceCap });
  }
  if (settings.qShadows === 'on') q.shadows = true;
  if (settings.qShadows === 'off') q.shadows = false;
  if (settings.qDistance && settings.qDistance !== 'preset') q.distance = DISTANCE[settings.qDistance];
  q.fixedScale = settings.qRes && settings.qRes !== 'auto' ? Number(settings.qRes) : null;
  return q;
}

/** 目標FPSを保つための動的解像度（固定倍率の指定があればそれを使う） */
export class DynamicResolution {
  constructor(renderer, preset) {
    this.renderer = renderer;
    this.set(preset);
  }

  set(preset) {
    this.preset = preset;
    this.scale = preset.fixedScale || 1;
    this.acc = 0; this.frames = 0;
    this.lowStreak = 0;
    this.apply();
  }

  apply() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.preset.pixelRatio);
    this.renderer.setPixelRatio(dpr * this.scale);
  }

  /** @returns {boolean} 解像度を下げきっても重い状態が続いている */
  tick(dt) {
    this.acc += dt; this.frames++;
    if (this.acc < 2) return false;
    const fps = this.frames / this.acc;
    this.fps = fps;
    this.acc = 0; this.frames = 0;
    const t = this.preset.targetFps;
    if (this.preset.fixedScale) return false;
    if (fps < t * 0.85 && this.scale > this.preset.minScale + 1e-6) {
      this.scale = Math.max(this.preset.minScale, this.scale - 0.1);
      this.apply();
    } else if (fps > t * 1.15 && this.scale < 1) {
      this.scale = Math.min(1, this.scale + 0.05);
      this.apply();
    }
    if (this.scale <= this.preset.minScale + 1e-6 && fps < t * 0.75) this.lowStreak++;
    else this.lowStreak = 0;
    return this.lowStreak >= 3; // 6秒続いた
  }
}
