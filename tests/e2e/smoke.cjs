// ブラウザでの通しテスト（P6）：初見で出荷し、ちりモンを回収できるか。PC とスマホの両方で確かめる。
// 使い方: npm run e2e  （Playwright と Chromium が必要: npm i -D playwright && npx playwright install chromium）
const { spawn } = require('node:child_process');
const path = require('node:path');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch {
  console.error('Playwright がありません。npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '../..');
const PORT = 4179;
const URL = `http://localhost:${PORT}/`;
const checks = [];
const ok = (name, cond, info = '') => { checks.push({ name, cond: !!cond }); console.log(`${cond ? '✔' : '✖'} ${name}${info ? ` (${info})` : ''}`); };

async function flow(browser, label, ctxOpts, touch) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  const tap = (sel) => (touch ? page.tap(sel) : page.click(sel));
  // 描画フレームを待つ（ソフトウェア描画では1フレームが長い）
  const frames = (n = 2) => page.evaluate((n) => new Promise((r) => { const f = (k) => (k ? requestAnimationFrame(() => f(k - 1)) : r()); f(n); }), n);
  const act = async (a) => { await page.evaluate((a) => window.__game.input.actions.push(a), a); await frames(); };
  const set = async (o) => { await page.evaluate((o) => Object.assign(window.__game.player, o), o); await frames(); };
  const tapF = async (sel) => { await tap(sel); await frames(); };
  const st = () => page.evaluate(() => { const { game, pile } = window.__game; return { money: game.money, packs: game.packs, hand: game.hand.length, prot: game.stats.protected, fp: pile.fingerprint(), inv: game.invariant().ok }; });

  await page.goto(URL);
  await page.waitForSelector('#btnNew');
  await page.waitForTimeout(1500);
  ok(`${label}: タイトル画面`, await page.isVisible('#btnNew'));
  await tap('#btnNew');
  await page.waitForTimeout(500);
  ok(`${label}: 目標の矢印が出る`, await page.evaluate(() => !document.getElementById('guide').hidden || document.querySelector('#hud') != null));

  // 山の手前で、しらすをつまむ（実際の照準処理を通す）
  await set({ x: -2.0, z: 0.2, yaw: Math.PI / 2, pitch: -0.75 });
  await page.waitForTimeout(400);
  if (touch) await tapF('#btnPick'); else await act('pick');
  await page.waitForTimeout(300);
  ok(`${label}: しらすをつまめる`, (await st()).hand === 1);

  // 計量機へ運んではなす → 20匹たまるまで繰り返す（手袋は端末で買う）
  for (let k = 0; k < 20; k++) {
    if (k > 0) {
      await set({ x: -2.0, z: 0.2 + (k % 5) * 0.1, yaw: Math.PI / 2, pitch: -0.75 });
      await page.waitForTimeout(150);
      if (touch) await tapF('#btnPick'); else await act('pick');
      await page.waitForTimeout(150);
    }
    await set({ x: 3.0, z: -1.6, yaw: Math.PI * 1.5, pitch: -0.55 });
    await page.waitForTimeout(150);
    if (touch) await tapF('#btnRelease'); else await act('release');
    await page.waitForTimeout(150);
  }
  if (touch) await tapF('#btnAction'); else await act('interact');
  await page.waitForTimeout(400);
  const s1 = await st();
  ok(`${label}: 包装して出荷できる`, s1.packs >= 1 && s1.money >= 20, `${s1.packs}パック ${s1.money}円`);

  // 購入端末で手袋を買う
  await set({ x: 7.2, z: 5.2, yaw: -Math.PI / 2, pitch: -0.2 });
  await page.waitForTimeout(300);
  if (touch) await tapF('#btnAction'); else await act('interact');
  await page.waitForTimeout(400);
  await tap('[data-buy="glove1"]');
  await tap('#shopClose');
  await page.waitForTimeout(300);
  ok(`${label}: 手袋を買える`, await page.evaluate(() => window.__game.game.has('glove1')));

  // 計量機側の斜面を掘り進めて、最初に出てくるちりモンを見つける（掘る作業は内部 API で早送り）
  const target = await page.evaluate(() => {
    const { pile, game } = window.__game;
    const cand = pile.chiriList.map(({ id }) => ({ id, t: pile.fishTransform(id) })).filter(({ t }) => t.x > pile.cx + 1.5 && Math.abs(t.z) < 1.5);
    cand.sort((a, b) => (pile.h0[pile.columnOf(a.id)] - a.t.y) - (pile.h0[pile.columnOf(b.id)] - b.t.y));
    const { id } = cand[0];
    const c = pile.columnOf(id);
    let n = 0;
    while (!pile.isExposed(id)) { const top = pile.start[c] + pile.top[c]; pile.remove(top); game.shipped++; n++; }
    return { id, n, ...pile.visualTransform(id) };
  });
  await set({ x: target.x + 1.0, z: target.z, yaw: Math.PI / 2, pitch: -Math.atan2(1.6 - target.y, 1.0) });
  await page.waitForTimeout(800);
  const prompt = await page.evaluate(() => document.getElementById('prompt').textContent);
  ok(`${label}: 露出したちりモンに照準が合う`, /何かいる|つまむ/.test(prompt), prompt.split('\n')[0]);
  if (touch) await tapF('#btnPick'); else await act('pick');
  await page.waitForTimeout(300);
  ok(`${label}: ちりモンをつまめる`, await page.evaluate((id) => window.__game.game.hand.includes(id), target.id));
  await set({ x: 1.6, z: 4.4, yaw: Math.PI, pitch: -0.45 });
  await page.waitForTimeout(300);
  if (touch) await tapF('#btnRelease'); else await act('release');
  await page.waitForTimeout(400);
  const s2 = await st();
  ok(`${label}: 保護ケースで図鑑に登録される`, s2.prot === 1 && s2.inv);

  // 保存 → 再読み込み → つづきから
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForSelector('#btnContinue', { state: 'visible' });
  await tap('#btnContinue');
  await page.waitForTimeout(500);
  const s3 = await st();
  ok(`${label}: 再読み込み後に同じ状態から再開`, s3.fp === s2.fp && s3.prot === 1 && Math.floor(s3.money) === Math.floor(s2.money));
  ok(`${label}: ページエラーなし`, errors.length === 0, errors.join(' / '));
  await ctx.close();
}

(async () => {
  const server = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    await flow(browser, 'PC', { viewport: { width: 1280, height: 720 } }, false);
    await flow(browser, 'スマホ', { ...devices['Pixel 7 landscape'] }, true);
  } catch (e) {
    console.error(e);
    checks.push({ name: 'exception', cond: false });
  } finally {
    await browser.close();
    server.kill();
  }
  const failed = checks.filter((c) => !c.cond);
  console.log(failed.length ? `\n${failed.length} 件失敗` : `\nすべて成功（${checks.length} 件）`);
  process.exit(failed.length ? 1 : 0);
})();
