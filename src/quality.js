// 画質プリセット（企画書 5章）
export const PRESETS = {
  low: {
    label: '低画質', pixelRatio: 1, minScale: 0.5, nearRadius: 1.7, perColumn: 6,
    instanceCap: 14000, shadows: false, shadowSize: 512, targetFps: 30, aid: true,
  },
  standard: {
    label: '標準', pixelRatio: 1.5, minScale: 0.6, nearRadius: 2.5, perColumn: 12,
    instanceCap: 40000, shadows: true, shadowSize: 1024, targetFps: 45, aid: false,
  },
  high: {
    label: '高画質', pixelRatio: 2, minScale: 0.75, nearRadius: 3.3, perColumn: 20,
    instanceCap: 100000, shadows: true, shadowSize: 2048, targetFps: 60, aid: false,
  },
};

export function autoPreset(isTouch) {
  if (isTouch) return 'low';
  const cores = navigator.hardwareConcurrency || 4;
  return cores >= 8 ? 'standard' : 'low';
}

export function resolvePreset(name, isTouch) {
  const key = name === 'auto' ? autoPreset(isTouch) : name;
  return { key, ...PRESETS[key] };
}

/** 目標FPSを保つための動的解像度 */
export class DynamicResolution {
  constructor(renderer, preset) {
    this.renderer = renderer;
    this.set(preset);
  }

  set(preset) {
    this.preset = preset;
    this.scale = 1;
    this.acc = 0; this.frames = 0;
    this.apply();
  }

  apply() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.preset.pixelRatio);
    this.renderer.setPixelRatio(dpr * this.scale);
  }

  tick(dt) {
    this.acc += dt; this.frames++;
    if (this.acc < 2) return;
    const fps = this.frames / this.acc;
    this.fps = fps;
    this.acc = 0; this.frames = 0;
    const t = this.preset.targetFps;
    if (fps < t * 0.85 && this.scale > this.preset.minScale) {
      this.scale = Math.max(this.preset.minScale, this.scale - 0.1);
      this.apply();
    } else if (fps > t * 1.15 && this.scale < 1) {
      this.scale = Math.min(1, this.scale + 0.05);
      this.apply();
    }
  }
}
