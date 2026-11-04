// ゲーム状態と行動（つまむ・はなす・計量・包装・保護）。three.js 非依存。
//
// 山から取り除かれた個体は、必ず次のどこか1か所だけに存在する（複製しない）:
//   手（hand） / 床（floor） / 計量機（scale） / 搬送設備（factory） / 出荷済み（shipped） / 保護ケース（protected・ちりモンのみ）
// invariant() でこの保存則を検査できる。

import { PACK_SIZE, PACK_PRICE, UPGRADES } from './config.js';
import { SPECIES } from './chirimonData.js';
import { Factory } from './factory.js';

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
    else this.stats.p4gift = true; // P4 以降に始めたゲームには電力移行の支給は不要
    this.factory = new Factory(this, saved?.factory);
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

  holdCap() {
    let cap = 0;
    for (const u of UPGRADES) if (u.holdCap && this.has(u.id)) cap = Math.max(cap, u.holdCap);
    return cap;
  }

  /** 持てる上限（スコップは運搬箱・台車でためられる） */
  capacity() { return this.tool === 'scoop' ? Math.max(this.scoopCap(), this.holdCap()) : this.handCap(); }
  /** 1回でつかめる／すくえる数 */
  perAction() { return this.tool === 'scoop' ? this.scoopCap() : this.handCap(); }
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
    const room = Math.min(this.capacity() - this.hand.length, this.perAction());
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
    const room = Math.min(this.capacity() - this.hand.length, this.perAction());
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
    const room = Math.min(this.capacity() - this.hand.length, this.perAction());
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
      this._ship(this.scale.splice(0, PACK_SIZE));
      made++;
    }
    this.emit('packed', { count: made, money: made * PACK_PRICE });
    this.emit('scale');
    this.emit('changed');
    return made;
  }

  /** 1パック分を出荷する（ちりモンが混ざっていれば誤出荷） */
  _ship(ids) {
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
  }

  // ===== 搬送設備との受け渡し（factory.js から呼ばれる） =====
  /** 包装機からの出荷 */
  shipPack(ids) {
    this._ship(ids);
    this.machinePacks = (this.machinePacks || 0) + 1;
    this.emit('machinePacked');
  }

  /** クレーンなどが山から取り除く（実在する未処理IDだけを選ぶ） */
  machineGrab(x, z, r, n) {
    const ids = this.pile.scrape(x, z, r, n);
    const chiri = ids.filter((id) => this.pile.isChirimon(id));
    for (const id of chiri) this.chiriState.set(id, 'machine');
    if (ids.length) this.emit('machineGrab', { count: ids.length, chiri: chiri.length });
    return ids;
  }

  factoryToScale(ids) {
    for (const id of ids) {
      this.scale.push(id);
      if (this.pile.isChirimon(id)) this.chiriState.set(id, 'scale');
    }
    if (ids.some((id) => this.pile.isChirimon(id))) this.emit('chiriInScale', { ids });
    if (this.has('autopack')) this.pack(true);
    this.emit('scale');
  }

  releaseToMachine(m) {
    if (!this.hand.length) return 0;
    const n = this.factory.insertFromHand(m, this.hand);
    if (!n) { this.emit('toast', { text: m.type === 'crane' ? 'クレーンには入れられない' : 'いっぱいで入らない' }); return 0; }
    const ids = this.hand.splice(0, n);
    for (const id of ids) if (this.pile.isChirimon(id)) this.chiriState.set(id, 'machine');
    this.emit('released', { to: 'machine', count: n });
    this.emit('changed');
    return n;
  }

  pickFromMachine(m) {
    const room = Math.min(this.capacity() - this.hand.length, Math.max(this.perAction(), 1));
    if (room <= 0) { this.emit('toast', { text: 'これ以上持てない' }); return 0; }
    const ids = this.factory.takeFrom(m, room);
    if (!ids.length) return 0;
    this._takeIntoHand(ids);
    return ids.length;
  }

  /** 撤去した設備の中身などを床に落とす */
  dropIdsToFloor(ids, p, rand = Math.random) {
    const spread = 0.05 + 0.01 * Math.sqrt(ids.length);
    for (const id of ids) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * spread;
      this.floor.push({ id, x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r, rot: rand() * Math.PI * 2 });
      if (this.pile.isChirimon(id)) this.chiriState.set(id, 'floor');
    }
  }

  // ===== 集計 =====
  /** 1山を処理し尽くした（山にも手・床・計量機・設備にも個体が残っていない） */
  isCleared() {
    const p = this.pile;
    return p.removedCount >= p.total && !this.hand.length && !this.floor.length && !this.scale.length && !this.factory.count();
  }

  /** この山の成績（見逃し数・発見数・売上・処理時間） */
  pileResult() {
    const per = this.chiriCounts();
    const sum = (k) => per.reduce((a, b) => a + b[k], 0);
    return { time: this.pileTime || 0, packs: this.packs, sales: this.packs * PACK_PRICE, protected: sum('protected'), misshipped: sum('misshipped'), total: sum('total') };
  }

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
    const inFactory = this.factory ? this.factory.allIds() : [];
    const accounted = this.hand.length + this.floor.length + this.scale.length + inFactory.length + this.shipped + prot;
    const ids = [...this.hand, ...this.floor.map((f) => f.id), ...this.scale, ...inFactory];
    const unique = new Set(ids).size === ids.length;
    const allRemoved = ids.every((id) => this.pile.isRemoved(id));
    return { ok: accounted === this.pile.removedCount && unique && allRemoved, accounted, removed: this.pile.removedCount, unique, allRemoved };
  }

  /** 新しい山へ（お金・道具・図鑑は引き継ぐ） */
  startNewPile(pile) {
    this.pile = pile;
    this.hand = []; this.floor = []; this.scale = [];
    this.shipped = 0; this.packs = 0; this.pileTime = 0; this.clearShown = false;
    this.chiriState = new Map();
    this.tool = 'hand';
    this.factory.clearContents(); // 設備は引き継ぐ（中身は前の山の個体なので片付ける）
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
      pileTime: this.pileTime || 0,
      factory: this.factory.toJSON(),
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
    this.pileTime = s.pileTime || 0;
  }
}
