// 入力：PC（WASD＋マウス・ポインターロック）とスマホ（仮想スティック＋スワイプ＋ボタン）
export class Input {
  constructor(canvas, ui) {
    this.canvas = canvas;
    this.keys = new Set();
    this.look = { x: 0, y: 0 };
    this.move = { x: 0, y: 0 };
    this.actions = [];
    this.holdPick = false;
    this.holdTimer = 0;
    this.enabled = false;
    this.touch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this.locked = false;
    this.onLockChange = null;

    addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (e.repeat) return;
      this.keys.add(e.code);
      const map = { KeyQ: 'release', KeyE: 'interact', KeyF: 'interact', Digit1: 'tool1', Digit2: 'tool2', Tab: 'dex', KeyR: 'release', KeyB: 'build' };
      if (map[e.code]) { this.actions.push(map[e.code]); e.preventDefault(); }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.holdPick = false; });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled || this.touch) return;
      if (!this.locked) { this.requestLock(); return; }
      if (e.button === 0) { this.actions.push('pick'); this.holdPick = true; this.holdTimer = 0.35; }
      if (e.button === 2) this.actions.push('release');
    });
    addEventListener('mouseup', (e) => { if (e.button === 0) this.holdPick = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.look.x += e.movementX;
      this.look.y += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      this.onLockChange?.(this.locked);
    });

    if (this.touch) this._setupTouch(ui);
  }

  requestLock() {
    if (this.touch) return;
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => this.canvas.requestPointerLock());
    } catch { this.canvas.requestPointerLock(); }
  }

  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  _setupTouch(ui) {
    const stick = ui.stick, knob = ui.knob, lookZone = ui.lookZone;
    let stickId = null, sx = 0, sy = 0;
    const R = 55;
    ui.stickZone.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      stickId = e.pointerId; sx = e.clientX; sy = e.clientY;
      stick.style.left = `${sx}px`; stick.style.top = `${sy}px`;
      stick.classList.add('on');
      ui.stickZone.setPointerCapture(e.pointerId);
    });
    ui.stickZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== stickId) return;
      let dx = e.clientX - sx, dy = e.clientY - sy;
      const l = Math.hypot(dx, dy);
      if (l > R) { dx *= R / l; dy *= R / l; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.move.x = dx / R; this.move.y = -dy / R;
    });
    const endStick = (e) => {
      if (e.pointerId !== stickId) return;
      stickId = null;
      this.move.x = this.move.y = 0;
      knob.style.transform = '';
      stick.style.left = stick.style.top = '';
      stick.classList.remove('on');
    };
    ui.stickZone.addEventListener('pointerup', endStick);
    ui.stickZone.addEventListener('pointercancel', endStick);

    const lookIds = new Map();
    lookZone.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      lookIds.set(e.pointerId, { x: e.clientX, y: e.clientY });
      lookZone.setPointerCapture(e.pointerId);
    });
    lookZone.addEventListener('pointermove', (e) => {
      const p = lookIds.get(e.pointerId);
      if (!p) return;
      this.look.x += (e.clientX - p.x) * 2.2;
      this.look.y += (e.clientY - p.y) * 2.2;
      p.x = e.clientX; p.y = e.clientY;
    });
    const endLook = (e) => lookIds.delete(e.pointerId);
    lookZone.addEventListener('pointerup', endLook);
    lookZone.addEventListener('pointercancel', endLook);

    const bind = (el, action, hold = false) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!this.enabled) return;
        this.actions.push(action);
        if (hold) { this.holdPick = true; this.holdTimer = 0.4; }
        el.classList.add('down');
      });
      const up = () => { if (hold) this.holdPick = false; el.classList.remove('down'); };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', up);
    };
    bind(ui.btnPick, 'pick', true);
    // はなす：設定で「長押しで実行」にできる（誤タップ防止）
    const rel = ui.btnRelease;
    let relTimer = null;
    rel.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!this.enabled) return;
      rel.classList.add('down');
      if (this.settings && this.settings.holdRelease) {
        rel.classList.add('charging');
        relTimer = setTimeout(() => { relTimer = null; rel.classList.remove('charging'); this.actions.push('release'); }, 350);
      } else this.actions.push('release');
    });
    const relUp = () => { rel.classList.remove('down', 'charging'); if (relTimer) { clearTimeout(relTimer); relTimer = null; } };
    rel.addEventListener('pointerup', relUp);
    rel.addEventListener('pointercancel', relUp);
    rel.addEventListener('pointerleave', relUp);
    bind(ui.btnAction, 'interact');
    bind(ui.btnTool, 'toolToggle');
    bind(ui.btnBuild, 'build');
  }

  /** 1フレーム分の入力をまとめて取り出す */
  poll(dt) {
    if (!this.touch) {
      let x = 0, y = 0;
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
      this.move.x = x; this.move.y = y;
    }
    if (this.holdPick) {
      this.holdTimer -= dt;
      if (this.holdTimer <= 0) { this.actions.push('pick'); this.holdTimer = 0.22; }
    }
    const look = { ...this.look };
    this.look.x = this.look.y = 0;
    const actions = this.actions;
    this.actions = [];
    return { move: this.move, look, actions };
  }
}
