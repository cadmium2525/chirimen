// HUD・メニュー・図鑑・記録・設定・ショップ
import { UPGRADES, TOTAL_FISH, PACK_SIZE, PACK_PRICE, GAME_VERSION, CHANGELOG } from './config.js';
import { SPECIES } from './chirimonData.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.floor(n).toLocaleString('ja-JP');

export class UI {
  constructor() {
    this.el = {
      hud: $('hud'), touch: $('touch'), prompt: $('prompt'), cross: $('crosshair'), money: $('money'), hand: $('hand'),
      tool: $('tool'), objective: $('objective'), warn: $('warn'), toasts: $('toasts'), perf: $('perf'),
      start: $('start'), menu: $('menu'), shop: $('shop'), tabBody: $('tabBody'), tabs: $('tabs'),
      shopList: $('shopList'), shopMoney: $('shopMoney'),
    };
    this.stick = $('stick'); this.knob = $('knob'); this.stickZone = $('stickZone'); this.lookZone = $('lookZone');
    this.btnPick = $('btnPick'); this.btnRelease = $('btnRelease'); this.btnAction = $('btnAction'); this.btnTool = $('btnTool');
    this.btnMenu = $('btnMenu'); this.btnBuild = $('btnBuild');
    this.tab = 'dex';
    this.el.power = document.createElement('div');
    this.el.power.className = 'chip';
    this.el.power.hidden = true;
    document.getElementById('topbar').appendChild(this.el.power);
    this.thumbs = null;
  }

  // ===== HUD =====
  setPrompt(text, cls = '') {
    if (this._prompt !== text) { this.el.prompt.textContent = text; this._prompt = text; }
    this.el.cross.className = cls;
  }

  updateHUD(game) {
    this.el.money.textContent = `${fmt(game.money)}円`;
    const cap = game.capacity();
    const chiri = game.heldChirimon().length;
    this.el.hand.textContent = `${game.tool === 'scoop' ? 'スコップ' : '手'} ${game.hand.length} / ${cap}匹` + (chiri ? `（ちりモン ${chiri}）` : '');
    this.el.hand.classList.toggle('warn', chiri > 0);
    const hasScoop = game.scoopCap() > 0;
    this.el.tool.hidden = !hasScoop;
    this.el.tool.textContent = hasScoop ? (game.tool === 'scoop' ? '[1] 手 / [2] スコップ ◀' : '[1] 手 ◀ / [2] スコップ') : '';
    this.el.warn.textContent = chiri ? '⚠ ちりモンを持っている！ 保護ケースへ運ぼう' : '';
    this.btnTool.hidden = !hasScoop;
  }

  setPower(ps) {
    const el = this.el.power;
    el.hidden = !ps;
    if (!ps) return;
    el.textContent = `⚡ ${ps.demand.toFixed(1)}/${ps.supply.toFixed(1)}kW${ps.unpowered ? ` 電源なし${ps.unpowered}` : ''}`;
    el.style.color = ps.short || ps.unpowered ? '#ff7a6b' : '#7ee2a0';
  }

  setObjective(html) {
    if (this._obj !== html) { this.el.objective.innerHTML = html; this._obj = html; }
  }

  toast(text, type = '') {
    const d = document.createElement('div');
    d.className = `toast ${type}`;
    d.textContent = text;
    this.el.toasts.prepend(d);
    while (this.el.toasts.children.length > 4) this.el.toasts.lastChild.remove();
    setTimeout(() => d.remove(), 3300);
  }

  setActionLabel(text) {
    if (this.btnAction.textContent !== text) this.btnAction.textContent = text;
  }

  // ===== メニュー =====
  openMenu(tab, ctx) {
    this.ctx = ctx;
    this.el.menu.hidden = false;
    this.showTab(tab || this.tab);
  }

  closeMenu() { this.el.menu.hidden = true; }

  bindMenu(handlers) {
    this.el.tabs.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tab === 'resume') handlers.resume();
      else this.showTab(b.dataset.tab);
    });
    $('shopClose').addEventListener('click', () => handlers.closeShop());
  }

  showTab(tab) {
    this.tab = tab;
    for (const b of this.el.tabs.querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === tab);
    const body = this.el.tabBody;
    const { game, settings, onSetting, onNewPile, touch } = this.ctx;
    if (tab === 'dex') body.innerHTML = this._dexHTML(game);
    if (tab === 'stats') body.innerHTML = this._statsHTML(game);
    if (tab === 'help') body.innerHTML = `<h2>操作</h2><div class="controls-help">${helpHTML(touch)}</div>${rulesHTML()}<h3>更新履歴</h3><ul class="small">${CHANGELOG.map(([v, t]) => `<li><b>v${v}</b> ${t}</li>`).join('')}</ul><p class="muted small">しらすの山 v${GAME_VERSION}　/　素材はすべてコードで自作</p>`;
    if (tab === 'settings') {
      body.innerHTML = this._settingsHTML(settings);
      body.querySelectorAll('[data-set]').forEach((el) => {
        const key = el.dataset.set;
        const handler = () => {
          let v = el.type === 'checkbox' ? el.checked : el.value;
          if (el.type === 'range') v = Number(v);
          onSetting(key, v);
        };
        el.addEventListener('input', handler);
        el.addEventListener('change', handler);
      });
      body.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
        onSetting(b.parentElement.dataset.seg, b.dataset.v);
        this.showTab('settings');
      }));
      const { onSaveNow, onExport, onImport, onWipe, fullscreen } = this.ctx;
      $('btnSaveNow')?.addEventListener('click', async () => { await onSaveNow?.(); this.showTab('settings'); });
      $('btnExport')?.addEventListener('click', () => onExport?.());
      $('btnImport')?.addEventListener('click', () => onImport?.());
      $('btnWipe')?.addEventListener('click', () => onWipe?.());
      $('btnFull')?.addEventListener('click', () => fullscreen?.());
      $('btnNewPile').addEventListener('click', () => {
        if (confirm('今の山を手放して、新しいシードの山を始めますか？\n（お金・道具・図鑑は引き継ぎます。今の山のちりモンには二度と会えません）')) onNewPile();
      });
    }
    if (tab === 'stats') {
      $('btnCheck')?.addEventListener('click', () => {
        const r = game.invariant();
        $('checkOut').textContent = r.ok
          ? `✔ 整合性OK：山から除去 ${fmt(r.removed)}匹 ＝ 手・床・計量機・出荷・保護の合計 ${fmt(r.accounted)}匹（重複なし）`
          : `✖ 不整合：除去 ${r.removed} / 合計 ${r.accounted} / 重複なし=${r.unique}`;
      });
    }
  }

  _dexHTML(game) {
    const per = game.chiriCounts();
    const cards = SPECIES.map((sp, i) => {
      const d = game.dex[sp.id];
      const known = d && d.protected > 0;
      const seen = d && (d.protected > 0 || d.misshipped > 0);
      const img = `<div class="ph">${this.thumbs ? `<img src="${this.thumbs[i]}" alt="">` : '<img alt="">'}</div>`;
      return `<div class="card ${known ? '' : 'unknown'}">${img}
        <div class="name">${known ? sp.name : (seen ? sp.name + '？' : '？？？')}</div>
        <div class="stars">${'★'.repeat(sp.rarity)}${'☆'.repeat(5 - sp.rarity)}</div>
        ${known ? `<div class="desc">${sp.desc}</div>` : '<div class="desc">まだ保護していない。</div>'}
        <div class="nums">通算保護 ${d ? d.protected : 0}${d && d.misshipped ? ` / <span class="bad">見逃し ${d.misshipped}</span>` : ''}<br>
        この山：保護 ${per[i].protected}${per[i].misshipped ? ` / <span class="bad">見逃し ${per[i].misshipped}</span>` : ''}${known ? ` / 生息 ${per[i].total}` : ''}</div>
      </div>`;
    }).join('');
    const found = SPECIES.filter((sp) => game.dex[sp.id]?.protected).length;
    return `<h2>ちりモン図鑑 <span class="chip">${found} / ${SPECIES.length} 種</span></h2><div class="dex">${cards}</div>
      <p class="muted small">ちりモンは後から湧きません。この山にいる個体は、最初から埋まっている位置が決まっています。保護した種類は「生息数」がわかるようになります。</p>`;
  }

  _statsHTML(game) {
    const pile = game.pile;
    const pct = (pile.removedCount / TOTAL_FISH) * 100;
    const per = game.chiriCounts();
    const total = per.reduce((a, b) => a + b.total, 0);
    const prot = per.reduce((a, b) => a + b.protected, 0);
    const miss = per.reduce((a, b) => a + b.misshipped, 0);
    const t = game.stats.playTime;
    const time = `${Math.floor(t / 3600)}時間${Math.floor((t % 3600) / 60)}分${Math.floor(t % 60)}秒`;
    return `<h2>記録</h2>
      <div>山の処理状況：${fmt(pile.removedCount)} / ${fmt(TOTAL_FISH)} 匹（${pct < 0.01 && pct > 0 ? '0.01未満' : pct.toFixed(2)}%）</div>
      <div class="bar"><div style="width:${Math.min(100, pct)}%"></div></div>
      <table class="stats">
        <tr><td>この山で出荷したパック</td><td>${fmt(game.packs)} パック（${fmt(game.shipped)}匹）</td></tr>
        <tr><td>計量機に残っている端数</td><td>${game.scale.length}匹</td></tr>
        <tr><td>床に落ちている個体</td><td>${game.floor.length}匹</td></tr>
        <tr><td>この山のちりモン</td><td>保護 ${prot} / 見逃し ${miss} / 埋没・未発見 ${total - prot - miss}</td></tr>
        <tr><td>通算 売上</td><td>${fmt(game.stats.sales)}円</td></tr>
        <tr><td>通算 パック</td><td>${fmt(game.stats.totalPacks)}</td></tr>
        <tr><td>通算 保護 / 見逃し</td><td>${game.stats.protected} / ${game.stats.misshipped}</td></tr>
        <tr><td>プレイ時間</td><td>${time}</td></tr>
        <tr><td>ワールドシード</td><td>${pile.seed}</td></tr>
      </table>
      <div class="row" style="justify-content:flex-start"><button id="btnCheck">個体IDの整合性を検査</button></div>
      <div id="checkOut" class="small muted"></div>`;
  }

  _settingsHTML(s) {
    const seg = (key, opts) => `<div class="seg" data-seg="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(s[key]) === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    const { touch, saveInfo, fullscreen, qualityInfo } = this.ctx;
    const si = saveInfo ? saveInfo() : {};
    const qi = qualityInfo ? qualityInfo() : {};
    const when = si.lastSaved ? new Date(si.lastSaved).toLocaleTimeString() : 'まだ保存していません';
    return `<h2>設定</h2>
    <h3>操作</h3><div class="settings">
      ${touch ? `<label>タッチ感度</label><input type="range" min="0.2" max="3" step="0.1" value="${s.touchSens}" data-set="touchSens">`
    : `<label>マウス感度</label><input type="range" min="0.2" max="3" step="0.1" value="${s.sens}" data-set="sens">`}
      <label>視野角（FOV）</label><input type="range" min="55" max="100" step="1" value="${s.fov}" data-set="fov">
      <label>歩行の揺れ</label>${seg('bob', [['true', 'ON'], ['false', 'OFF']])}
      <label>照準補助</label>${seg('assist', [['auto', '自動'], ['low', '弱'], ['mid', '中'], ['high', '強']])}
      <label>ちりモン強調</label>${seg('aid', [['auto', '自動'], ['on', 'ON'], ['off', 'OFF']])}
      <label>文字サイズ</label>${seg('textSize', [['s', '小'], ['m', '中'], ['l', '大']])}
      <label>効果音</label>${seg('sound', [['true', 'ON'], ['false', 'OFF']])}
      <label>目標の矢印</label>${seg('guide', [['true', 'ON'], ['false', 'OFF']])}
    </div>
    ${touch ? `<h3>スマホ</h3><div class="settings">
      <label>ボタン配置</label>${seg('layout', [['right', '右手'], ['left', '左手']])}
      <label>ボタンの大きさ</label>${seg('btnSize', [['s', '小'], ['m', '中'], ['l', '大']])}
      <label>はなすを長押しで実行</label>${seg('holdRelease', [['false', 'OFF'], ['true', 'ON']])}
      <label>振動</label>${seg('haptics', [['true', 'ON'], ['false', 'OFF']])}
      ${fullscreen ? '<label>全画面</label><div><button id="btnFull">全画面・横向き固定</button></div>' : ''}
    </div>
    <p class="muted small">「はなすを長押し」をONにすると、［はなす］を0.35秒押し続けたときだけはなします（つまむとの押し間違い防止）。照準補助「自動」はスマホでは「強」になります。</p>` : ''}
    <h3>画質</h3><div class="settings">
      <label>画質</label>${seg('quality', [['auto', '自動'], ['low', '低'], ['standard', '標準'], ['high', '高']])}
      <label>解像度</label>${seg('qRes', [['auto', '自動'], ['1', '100%'], ['0.75', '75%'], ['0.5', '50%']])}
      <label>近景のしらす</label>${seg('qDensity', [['preset', '画質に合わせる'], ['low', '少'], ['mid', '中'], ['high', '多']])}
      <label>影</label>${seg('qShadows', [['preset', '画質に合わせる'], ['on', 'ON'], ['off', 'OFF']])}
      <label>描画距離</label>${seg('qDistance', [['preset', '画質に合わせる'], ['short', '短'], ['mid', '中'], ['long', '長']])}
      <label>FPS表示</label>${seg('showFps', [['false', 'OFF'], ['true', 'ON']])}
    </div>
    <p class="muted small">いまの画質：${qi.label || ''}${qi.autoStep ? '（重いため自動で下げています）' : ''}。「自動」は端末に合わせて選び、重い状態が続くと一段下げます。解像度「自動」は目標FPSに合わせて描画解像度を上下させます。性能によっては目標FPS（低30／標準45／高60）に届かない端末があります。「ちりモン強調：自動」は低画質のときだけ光らせます。発見できる条件は画質で変わりません。</p>
    <h3>セーブ</h3>
    <div class="small">最後のセーブ：${when}${si.persistent ? '　・　この端末に永続保存（自動削除されにくい）' : ''}</div>
    <div class="row" style="justify-content:flex-start">
      <button id="btnSaveNow">今すぐセーブ</button>
      <button id="btnExport">書き出し（ファイル）</button>
      <button id="btnImport">読み込み（ファイル）</button>
    </div>
    <p class="muted small">セーブはこのブラウザの中に15秒ごと・アプリ切り替え時に自動保存されます（2つの枠に交互に書き、壊れていたら一つ前から復元）。別の端末へ移すときは「書き出し」したファイルを、移した先で「読み込み」してください。</p>
    <h3>山</h3>
    <div class="row" style="justify-content:flex-start"><button id="btnNewPile">新しい山を始める</button><button id="btnWipe">この端末のデータを消去</button></div>`;
  }

  // ===== ショップ =====
  openShop(game, onBuy) {
    this.el.shop.hidden = false;
    this._renderShop(game, onBuy);
  }

  _renderShop(game, onBuy) {
    this.el.shopMoney.textContent = `所持金 ${fmt(game.money)}円`;
    this.el.shopList.innerHTML = UPGRADES.map((u) => {
      const owned = game.has(u.id);
      const locked = u.requires && !game.has(u.requires);
      const req = locked ? `（先に「${UPGRADES.find((x) => x.id === u.requires).name}」が必要）` : '';
      return `<div class="shop-item ${owned ? 'owned' : ''} ${locked ? 'locked' : ''}">
        <div class="n">${u.name}</div>
        <button data-buy="${u.id}" ${owned || !game.canBuy(u) ? 'disabled' : ''}>${owned ? '購入済み' : `${fmt(u.price)}円`}</button>
        <div class="d">${u.desc}${req}</div></div>`;
    }).join('') + `<div class="shop-note">しらす ${PACK_SIZE}匹 = 1パック = ${PACK_PRICE}円（仮値）。コンベア・ホッパー・包装機・クレーンは建設画面（PC: B キー / スマホ: 建設ボタン）で設置します。設備には電力が必要です（受電盤 3kW は無料。足りなければ発電機・電柱を建設）。</div>`;
    this.el.shopList.querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', () => {
      onBuy(b.dataset.buy);
      this._renderShop(game, onBuy);
    }));
  }

  closeShop() { this.el.shop.hidden = true; }
}

export function helpHTML(touch) {
  if (touch) {
    return `<span>左側をドラッグ</span><span>歩く（仮想スティック）</span>
      <span>右側をスワイプ</span><span>見回す</span>
      <span><kbd>つまむ</kbd></span><span>照準の近くの露出したしらす／ちりモンをつまむ（長押しで連続）</span>
      <span><kbd>はなす</kbd></span><span>狙った場所にはなす（計量機・保護ケース・床）</span>
      <span><kbd>調べる</kbd></span><span>包装する／ショップ／図鑑</span>
      <span><kbd>≡</kbd></span><span>メニュー（一時停止）</span>
      <span><kbd>建設</kbd></span><span>建設画面（搬送設備・選別機・発電機・電柱）</span>`;
  }
  return `<span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><span>歩く</span>
    <span>マウス</span><span>見回す（画面クリックで操作開始）</span>
    <span>左クリック</span><span>つまむ（長押しで連続）</span>
    <span>右クリック / <kbd>Q</kbd></span><span>はなす（狙った場所へ）</span>
    <span><kbd>E</kbd></span><span>包装する／ショップ／図鑑（狙った設備）</span>
    <span><kbd>1</kbd> <kbd>2</kbd></span><span>手 / スコップ の持ち替え</span>
    <span><kbd>B</kbd></span><span>建設画面（搬送設備・選別機・発電機・電柱）</span>
    <span><kbd>Tab</kbd></span><span>図鑑</span>
    <span><kbd>Esc</kbd></span><span>メニュー（一時停止）</span>`;
}

function rulesHTML() {
  return `<h3>あそびかた</h3>
  <ol class="small">
    <li>しらすの山から、露出しているしらすを<b>つまむ</b>。</li>
    <li>計量機の受け皿を狙って<b>はなす</b>。${PACK_SIZE}匹たまったら<b>包装</b>して出荷、${PACK_PRICE}円の売上。</li>
    <li>購入端末で手袋やスコップを買い、一度に運べる量を増やす。</li>
    <li>山を削ると、埋まっていた<b>ちりモン</b>が姿を現す。つまんで<b>保護ケース</b>へ運ぶと図鑑に登録。計量機に入れたまま包装すると<b>誤出荷（見逃し）</b>になる。</li>
    <li>計量機に入れてしまったちりモンは、包装前なら受け皿からつまみ出せる。</li>
    <li><b>建設</b>：クレーン → ホッパー → コンベア → 包装機（または計量機）とつなぐと自動で出荷できる。ただし機械はちりモンを見分けない。設備を止めて、ベルトやホッパーから手で取り出すこともできる。</li>
    <li><b>電力</b>：設備は配電範囲の中でだけ動く。受電盤（3kW）は無料、発電機（12kW）は負荷に応じて燃料費がかかる。電柱で電線を延ばせる。足りないと優先度の低い設備から止まる。</li>
    <li><b>選別機</b>：ラインの途中に置くと、ちりモンを85%の確率で回収箱へ分ける。処理は少し遅い。回収箱から取り出して保護ケースへ。</li>
  </ol>`;
}
