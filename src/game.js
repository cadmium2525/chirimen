// ゲーム状態と行動（つまむ・はなす・計量・包装・保護）。three.js 非依存。
//
// 山から取り除かれた個体は、必ず次のどこか1か所だけに存在する（複製しない）:
//   手（hand） / 床（floor） / 計量機（scale） / 出荷済み（shipped） / 保護ケース（protected・ちりモンのみ）
// invariant() でこの保存則を検査できる。

import { PACK_SIZE, PACK_PRICE, UPGRADES } from './config.js';
import { SPECIES } from './chirimonData.js';

const UPG = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));

export class Game {
  constructor(pile, saved = null, dex = null) {
    this.pile = pile;
    this.listeners = [];
    this.money = 0;
    this.upgrades = new Set();
    this.tool = 'hand';
    this.hand = [];
    this.floor = [];      // {id, x, z, rot}
    this.scale = [];      // 計量機の上の個体（入れた順）
    this.shipped = 0;     // 出荷済みの個体数（誤出荷のちりモンを含む）
    this.packs = 0;       // この山で出荷したパック数
    this.chiriState = new Map(); // 山から取り除かれたちりモン id -> 'held'|'floor'|'scale'|'protected'|'misshipped'
    this.stats = { sales: 0, playTime: 0, picks: 0, protected: 0, misshipped: 0, totalPacks: 0 };
    this.tutorial = 0;
    this.dex = dex || {};  // 恒久図鑑 speciesId -> {protected, misshipped}
    if (saved) this._load(saved);
  }

  on(fn) { this.listeners.push(fn); }
  emit(type, payload = {}) { for (const fn of this.listeners) fn(type, payload); }

  // ===== 能力 =====
  has(id) { return this.upgrades.has(id); }

  handCap() {
    let cap = 1;
    for (const u of UPGRADES) if (u.cap && this.has(u.id)) cap = Math.max(cap, u.cap);
    return cap;
  }

  scoopCap() {
    let cap = 0;
    for (const u of UPGRADES) if (u.scoopCap && this.has(u.id)) cap = Math.max(cap, u.scoopCap);
    return cap;
  }

  capacity() { return this.tool === 'scoop' ? this.scoopCap() : this.handCap(); }
  speedMul() { return this.has('boots') ? 1.35 : 1; }

  setTool(tool) {
    if (tool === this.tool) return true;
    if (tool === 'scoop' && !this.scoopCap()) { this.emit('toast', { text: 'スコップはまだ持っていない（端末で購入）' }); return false; }
    if (this.hand.length) { this.emit('toast', { text: '持ち替える前に、持っているものをはなそう' }); return false; }
    this.tool = tool;
    this.emit('tool', { tool });
    return true;
  }

  canBuy(u) {
    if (this.has(u.id)) return false;
    if (u.requires && !this.has(u.requires)) return false;
    return this.money >= u.price;
  }

  buy(id) {
    const u = UPG[id];
    if (!u || !this.canBuy(u)) return false;
    this.money -= u.price;
    this.upgrades.add(id);
    this.emit('bought', { upgrade: u });
    this.emit('changed');
    return true;
  }

  // ===== 手の中 =====
  heldChirimon() { return this.hand.filter((id) => this.pile.isChirimon(id)); }

  // ===== つまむ =====
  /**
   * 山の表面の点 p の近くから、露出した個体をつまむ。
   * @param {{x:number,y:number,z:number}} p 照準が当たった山の表面
   * @param {number} assist 照準補助の半径
   */
  pickFromPile(p, assist = 0.06) {
    const room = this.capacity() - this.hand.length;
    if (room <= 0) { this.emit('toast', { text: 'これ以上持てない' }); return 0; }
    const pile = this.pile;
    // 照準に最も近い露出個体（ちりモンは体が大きいので当たりやすい）
    let best = -1, bestD = Infinity;
    const tf = {};
    for (const c of pile.colsInRadius(p.x, p.z, assist)) {
      pile.forEachExposed(c, (id) => {
        tf.c = c;
        pile.visualTransform(id, tf);
        let d = Math.hypot(tf.x - p.x, (tf.y - p.y) * 1.5, tf.z - p.z);
        if (pile.isChirimon(id)) d *= 0.5;
        if (d < bestD) { bestD = d; best = id; }
      }, 80);
    }
    if (best < 0) return 0;
    const taken = [best];
    pile.remove(best);
    if (room > 1) {
      const r = this.tool === 'scoop' ? 0.06 + 0.01 * Math.sqrt(room) : 0.03 + 0.012 * Math.sqrt(room);
      const t = pile.fishTransform(best, {});
      taken.push(...pile.scrape(t.x, t.z, r, room - 1));
    }
    this._takeIntoHand(taken);
    return taken.length;
  }

  /** 床に落ちている個体をつまむ */
  pickFromFloor(p, radius = 0.14) {
    const room = this.capacity() - this.hand.length;
    if (room <= 0) { this.emit('toast', { text: 'これ以上持てない' }); return 0; }
    const near = [];
    for (let i = 0; i < this.floor.length; i++) {
      const f = this.floor[i];
      const d = Math.hypot(f.x - p.x, f.z - p.z) * (this.pile.isChirimon(f.id) ? 0.5 : 1);
      if (d <= radius) near.push({ i, d });
    }
    if (!near.length) return 0;
    near.sort((a, b) => a.d - b.d);
    const pick = near.slice(0, room);
    const idx = new Set(pick.map((n) => n.i));
    const ids = pick.map((n) => this.floor[n.i].id);
    this.floor = this.floor.filter((_, i) => !idx.has(i));
    this._takeIntoHand(ids);
    return ids.length;
  }

  floorItemsNear(p, radius = 0.14) {
    for (const f of this.floor) if (Math.hypot(f.x - p.x, f.z - p.z) <= radius) return true;
    return false;
  }

  /** 計量機からつまみ出す（混入したちりモンを優先して救出） */
  pickFromScale() {
    const room = this.capacity() - this.hand.length;
    if (room <= 0) { this.emit('toast', { text: 'これ以上持てない' }); return 0; }
    if (!this.scale.length) return 0;
    const chiri = this.scale.filter((id) => this.pile.isChirimon(id));
    let ids;
    if (chiri.length) ids = chiri.slice(0, room);
    else ids = this.scale.slice(-room);
    const set = new Set(ids);
    this.scale = this.scale.filter((id) => !set.has(id));
    this._takeIntoHand(ids);
    this.emit('scale');
    return ids.length;
  }

  _takeIntoHand(ids) {
    for (const id of ids) {
      this.hand.push(id);
      if (this.pile.isChirimon(id)) this.chiriState.set(id, 'held');
    }
    this.stats.picks += ids.length;
    const chiri = ids.filter((id) => this.pile.isChirimon(id));
    if (chiri.length) this.emit('chiriPicked', { ids: chiri });
    this.emit('picked', { count: ids.length });
    this.emit('changed');
  }

  // ===== はなす =====
  releaseToScale() {
    if (!this.hand.length) return 0;
    const ids = this.hand;
    this.hand = [];
    const chiri = [];
    for (const id of ids) {
      this.scale.push(id);
      if (this.pile.isChirimon(id)) { this.chiriState.set(id, 'scale'); chiri.push(id); }
    }
    if (chiri.length) this.emit('chiriInScale', { ids: chiri });
    this.emit('scale');
    this.emit('released', { to: 'scale', count: ids.length });
    if (this.has('autopack')) this.pack(true);
    this.emit('changed');
    return ids.length;
  }

  releaseToCase() {
    const chiri = this.heldChirimon();
    if (!chiri.length) {
      if (this.hand.length) this.emit('toast', { text: '保護ケースに入れられるのはちりモンだけ' });
      return 0;
    }
    const set = new Set(chiri);
    this.hand = this.hand.filter((id) => !set.has(id));
    for (const id of chiri) {
      this.chiriState.set(id, 'protected');
      const sp = SPECIES[this.pile.speciesOf(id)];
      const first = !this.dex[sp.id] || !this.dex[sp.id].protected;
      this.dex[sp.id] = this.dex[sp.id] || { protected: 0, misshipped: 0 };
      this.dex[sp.id].protected++;
      this.stats.protected++;
      this.emit('protected', { species: sp, first });
    }
    this.emit('released', { to: 'case', count: chiri.length });
    this.emit('changed');
    return chiri.length;
  }

  /** 床（または山の上）に落とす。落下地点で再び回収できる */
  releaseToFloor(p, rand = Math.random) {
    if (!this.hand.length) return 0;
    const ids = this.hand;
    this.hand = [];
    const spread = 0.02 + 0.012 * Math.sqrt(ids.length);
    for (const id of ids) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * spread;
      this.floor.push({ id, x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r, rot: rand() * Math.PI * 2 });
      if (this.pile.isChirimon(id)) this.chiriState.set(id, 'floor');
    }
    this.emit('released', { to: 'floor', count: ids.length });
    this.emit('changed');
    return ids.length;
  }

  // ===== 計量・包装・出荷 =====
  scaleCount() { return this.scale.length; }
  scaleHasChiri() { return this.scale.some((id) => this.pile.isChirimon(id)); }

  pack(auto = false) {
    if (this.scale.length < PACK_SIZE) {
      if (!auto) this.emit('toast', { text: `${PACK_SIZE}匹たまると包装できる（いま ${this.scale.length}匹）` });
      return 0;
    }
    let made = 0;
    while (this.scale.length >= PACK_SIZE) {
      const ids = this.scale.splice(0, PACK_SIZE);
      for (const id of ids) {
        if (this.pile.isChirimon(id)) {
          this.chiriState.set(id, 'misshipped');
          const sp = SPECIES[this.pile.speciesOf(id)];
          this.dex[sp.id] = this.dex[sp.id] || { protected: 0, misshipped: 0 };
          this.dex[sp.id].misshipped++;
          this.stats.misshipped++;
          this.emit('misshipped', { species: sp });
        }
      }
      this.shipped += ids.length;
      this.packs++;
      this.stats.totalPacks++;
      this.money += PACK_PRICE;
      this.stats.sales += PACK_PRICE;
      made++;
    }
    this.emit('packed', { count: made, money: made * PACK_PRICE });
    this.emit('scale');
    this.emit('changed');
    return made;
  }

  // ===== 集計 =====
  chiriCounts() {
    const per = SPECIES.map(() => ({ total: 0, protected: 0, misshipped: 0 }));
    for (const { id, species } of this.pile.chiriList) {
      per[species].total++;
      const st = this.chiriState.get(id);
      if (st === 'protected') per[species].protected++;
      if (st === 'misshipped') per[species].misshipped++;
    }
    return per;
  }

  /** 保存則：山から除去された数 = 手 + 床 + 計量機 + 出荷済み + 保護 */
  invariant() {
    let prot = 0;
    for (const st of this.chiriState.values()) if (st === 'protected') prot++;
    const accounted = this.hand.length + this.floor.length + this.scale.length + this.shipped + prot;
    const ids = [...this.hand, ...this.floor.map((f) => f.id), ...this.scale];
    const unique = new Set(ids).size === ids.length;
    const allRemoved = ids.every((id) => this.pile.isRemoved(id));
    return { ok: accounted === this.pile.removedCount && unique && allRemoved, accounted, removed: this.pile.removedCount, unique, allRemoved };
  }

  /** 新しい山へ（お金・道具・図鑑は引き継ぐ） */
  startNewPile(pile) {
    this.pile = pile;
    this.hand = []; this.floor = []; this.scale = [];
    this.shipped = 0; this.packs = 0;
    this.chiriState = new Map();
    this.tool = 'hand';
    this.emit('scale');
    this.emit('changed');
  }

  toJSON() {
    return {
      money: this.money,
      upgrades: [...this.upgrades],
      tool: this.tool,
      hand: this.hand,
      floor: this.floor,
      scale: this.scale,
      shipped: this.shipped,
      packs: this.packs,
      chiriState: [...this.chiriState],
      stats: this.stats,
      tutorial: this.tutorial,
    };
  }

  _load(s) {
    this.money = s.money ?? 0;
    this.upgrades = new Set(s.upgrades || []);
    this.tool = s.tool || 'hand';
    this.hand = s.hand || [];
    this.floor = s.floor || [];
    this.scale = s.scale || [];
    this.shipped = s.shipped || 0;
    this.packs = s.packs || 0;
    this.chiriState = new Map(s.chiriState || []);
    this.stats = { ...this.stats, ...(s.stats || {}) };
    this.tutorial = s.tutorial || 0;
  }
}
