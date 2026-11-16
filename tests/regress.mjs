/**
 * Browser regression for the maze.
 * Uses headless Chrome. The 390×844 pass is a simulated phone viewport, not a physical iPhone.
 *
 *   CHROME_PATH=/usr/bin/google-chrome npm test
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(join(root, 'index.html'));
const shotsDir = process.env.SHOTS_DIR || '/opt/cursor/artifacts';

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const url = `http://127.0.0.1:${port}/`;

const chrome = process.env.CHROME_PATH || '/usr/local/bin/google-chrome';
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-dev-shm-usage'
  ]
});

const results = [];
const errors = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  if (!cond) console.error('FAIL', name, detail);
  else console.log('ok  ', name, detail);
}

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(String(err && err.stack || err)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});

const iphone = {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true
};
await page.setViewport(iphone);
await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1');

await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => window.__maze && window.__maze.getState, { timeout: 20000 });

await page.evaluate(() => {
  localStorage.setItem('maze.theme', 'pearl');
  localStorage.setItem('maze.audio', JSON.stringify({
    musicId: 'piano', musicVol: 0.22, sfxOn: false, sfxVol: 0.33
  }));
});
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__maze);

const persisted = await page.evaluate(() => {
  const audio = window.__maze.audioState();
  return { theme: window.__maze.getTheme(), audio };
});
check('settings persist theme', persisted.theme === 'pearl', persisted.theme);
check('settings persist music', persisted.audio.musicId === 'piano' && persisted.audio.sfxOn === false, JSON.stringify(persisted.audio));
check('settings persist volume', Math.abs(persisted.audio.musicVol - 0.22) < 0.001 && Math.abs(persisted.audio.sfxVol - 0.33) < 0.001);

const targets = await page.evaluate(() => {
  const css = document.querySelector('style').textContent;
  const rect = (id) => {
    const el = document.getElementById(id);
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, hidden: el.hidden };
  };
  return {
    settings: rect('settingsBtn'),
    start: rect('startBtn'),
    swatch: document.querySelector('.swatch').getBoundingClientRect().height,
    chip: document.querySelector('.mchip') ? 0 : 0,
    safe: css.includes('safe-area-inset-top') && css.includes('safe-area-inset-bottom'),
    motion: css.includes('prefers-reduced-motion'),
    legendHidden: document.getElementById('legend').hidden,
    sheetDur: getComputedStyle(document.getElementById('sheet')).transitionDuration
  };
});
check('safe area css', targets.safe);
check('reduced motion css', targets.motion);
check('settings hit target', targets.settings.h >= 44 && targets.settings.w >= 44, JSON.stringify(targets.settings));
check('start hit target', targets.start.h >= 44, String(targets.start.h));
check('swatch hit target', targets.swatch >= 44, String(targets.swatch));
check('level 1 legend hidden', targets.legendHidden === true);
check('sheet motion duration', targets.sheetDur === '0.34s', targets.sheetDur);

await page.click('#settingsAlt');
const sheet = await page.evaluate(async () => {
  const el = document.getElementById('sheet');
  const start = performance.now();
  let transform = getComputedStyle(el).transform;
  let frames = 0;
  const settled = (t) => t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';
  while (!settled(transform) && frames < 30 && performance.now() - start < 800) {
    await new Promise((r) => requestAnimationFrame(r));
    frames += 1;
    transform = getComputedStyle(el).transform;
  }
  const animated = settled(transform);
  // SwiftShader can stall the compositor transition. The open rule is still the target style.
  if (!animated) {
    const prev = el.style.transition;
    el.style.transition = 'none';
    void el.offsetWidth;
    transform = getComputedStyle(el).transform;
    el.style.transition = prev;
  }
  return {
    open: el.classList.contains('open'),
    transform,
    animated,
    frames,
    hintHidden: document.getElementById('hint').style.visibility === 'hidden',
    expanded: document.getElementById('settingsBtn').getAttribute('aria-expanded')
  };
});
check('settings sheet opens', sheet.open && sheet.expanded === 'true', JSON.stringify(sheet));
check('sheet open position', sheet.transform === 'none' || sheet.transform === 'matrix(1, 0, 0, 1, 0, 0)', sheet.transform);
check('hint yields to sheet', sheet.hintHidden);

await page.evaluate(() => document.getElementById('sheetClose').click());
const closed = await page.evaluate(() => document.getElementById('sheet').classList.contains('open'));
check('settings sheet closes', closed === false);

await page.click('#startBtn');
await new Promise((r) => setTimeout(r, 200));
const audio = await page.evaluate(() => window.__maze.audioState());
check('audio unlocks on first click', audio.unlocked === true && audio.hasCtx === true, JSON.stringify(audio));

const logic = await page.evaluate(() => {
  const m = window.__maze;
  const out = {};
  const p1 = m.surfacePlan(1);
  const p2 = m.surfacePlan(2);
  const p6 = m.surfacePlan(6);
  out.plan = { p1, p2, p6 };
  m.buildLevel(1);
  out.level1Patches = m.getPatches().length;
  out.level1Friction = m.frictionAt(0, 0);
  out.level1Legend = document.getElementById('legend').hidden;

  m.buildLevel(6);
  const patches = m.getPatches();
  const st = m.getState();
  out.level6 = {
    n: patches.length,
    kinds: [...new Set(patches.map((p) => p.kind))],
    startF: m.frictionAt(st.start.x, st.start.z),
    exitF: m.frictionAt(st.exit.x, st.exit.z),
    legend: document.getElementById('legend').hidden
  };
  const rough = patches.find((p) => p.kind === 'rough');
  const slick = patches.find((p) => p.kind === 'slick');
  out.level6.roughF = rough ? m.frictionAt((rough.minX + rough.maxX) / 2, (rough.minZ + rough.maxZ) / 2) : null;
  out.level6.slickF = slick ? m.frictionAt((slick.minX + slick.maxX) / 2, (slick.minZ + slick.maxZ) / 2) : null;

  function coast(kind) {
    m.buildLevel(3);
    m.startPlay();
    if (kind) m.defineSurfaces([{ minX: -4, maxX: 4, minZ: -4, maxZ: 4, kind, axis: 'x' }], { rough: 3.6, slick: 0.15 });
    else m.defineSurfaces([], {});
    m.setWallsEnabled(false);
    m.place(0, 0, 4, 0);
    m.setTilt(0, 0);
    m.step(1.05);
    return m.getState().ball.x;
  }
  out.coast = { rough: coast('rough'), base: coast(null), slick: coast('slick') };

  m.buildLevel(3);
  m.startPlay();
  m.defineSurfaces([], {});
  m.setWallsEnabled(false);
  const steps0 = m.getState().physSteps;
  m.place(0, 0, 30, 0);
  m.setTilt(0, 0);
  m.step(0.2);
  const sped = m.getState();
  out.speed = Math.hypot(sped.vel.x, sped.vel.z);
  out.substeps = sped.physSteps - steps0;

  m.buildLevel(4);
  m.startPlay();
  const sig = m.surfaceSig();
  const lives0 = m.getState().lives;
  const placed = m.placeAtGap();
  m.step(2.3);
  const after = m.getState();
  out.fall = {
    placed: !!placed,
    lives0,
    lives1: after.lives,
    gameOver: after.gameOver,
    sameSurface: m.surfaceSig() === sig,
    nearStart: Math.hypot(after.ball.x - after.start.x, after.ball.z - after.start.z) < 0.2
  };

  m.buildLevel(5);
  out.nextSurface = m.surfaceSig() !== sig;

  m.buildLevel(2);
  m.startPlay();
  m.setLives(1);
  m.placeAtGap();
  m.step(2.3);
  const over = m.getState();
  out.gameOver = { lives: over.lives, gameOver: over.gameOver };

  m.buildLevel(1);
  m.startPlay();
  m.placeNearExit();
  m.step(0.25);
  out.won = m.getState().won === true;

  m.buildLevel(1);
  m.startPlay();
  m.setWallsEnabled(false);
  const start = m.getState().start;
  m.place(start.x, start.z, 2.2, 2.2);
  m.setTilt(0, 0);
  m.step(0.35);
  const hole = m.getState();
  out.hole = {
    dx: hole.ball.x - start.x,
    dz: hole.ball.z - start.z,
    vx: hole.vel.x,
    vz: hole.vel.z
  };

  m.setWallsEnabled(true);
  m.place(start.x, start.z, 0, 0);
  m.setTilt(-0.22, 0.22);
  m.step(1.1);
  const left = m.getState();
  out.leave = {
    d: Math.hypot(left.ball.x - start.x, left.ball.z - start.z),
    pen: m.penetrating(),
    finite: Number.isFinite(left.ball.x) && Number.isFinite(left.ball.z)
  };

  m.buildLevel(8);
  m.startPlay();
  m.setTilt(0.16, 0.2);
  let pen = 0;
  let finite = true;
  for (let i = 0; i < 18; i++) {
    m.step(0.16);
    pen = Math.max(pen, m.penetrating());
    const b = m.getState().ball;
    if (!Number.isFinite(b.x) || !Number.isFinite(b.z)) finite = false;
  }
  out.roam = { pen, finite, walls: m.wallMetrics() };

  const themes = m.listThemes();
  out.themes = themes;
  let caustic = 0;
  for (const id of themes) {
    m.setTheme(id);
    m.fitCamera();
    m.pump(0.4);
  }
  m.setTheme('jade');
  m.focusCorner();
  const grab = (t) => {
    m.pump(t);
    const pts = [];
    for (let y = 0.44; y <= 0.56; y += 0.04) {
      for (let x = 0.42; x <= 0.58; x += 0.04) pts.push(m.readPixel(x, y));
    }
    return pts;
  };
  const a = grab(0.15);
  const b = grab(2.8);
  for (let i = 0; i < a.length; i++) {
    caustic += Math.abs(a[i][0] - b[i][0]) + Math.abs(a[i][1] - b[i][1]) + Math.abs(a[i][2] - b[i][2]);
  }
  out.caustic = caustic;
  out.jadePx = b.reduce((best, p) => (p[1] - p[0] > best[1] - best[0] ? p : best), b[0]);
  return out;
});

check('six themes', logic.themes.length === 6 && logic.themes.includes('jade') && logic.themes.includes('glass'), logic.themes.join(','));
check('level 1 has no friction patches', logic.level1Patches === 0 && logic.level1Friction === 1.15 && logic.level1Legend === true);
check('plan grows with level', logic.plan.p1.count === 0 && logic.plan.p6.count > logic.plan.p2.count && logic.plan.p6.rough > logic.plan.p2.rough && logic.plan.p6.slick < logic.plan.p2.slick, JSON.stringify(logic.plan));
check('level 6 local patches', logic.level6.n >= 4 && logic.level6.kinds.includes('rough') && logic.level6.kinds.includes('slick') && logic.level6.legend === false, JSON.stringify(logic.level6));
check('spawn and exit stay neutral', Math.abs(logic.level6.startF - 1.15) < 0.08 && Math.abs(logic.level6.exitF - 1.15) < 0.08, JSON.stringify(logic.level6));
check('patch friction differs', logic.level6.roughF > 2 && logic.level6.slickF < 1 && logic.level6.roughF > logic.level6.slickF + 1, JSON.stringify(logic.level6));
check('coast distance rough < base < slick', logic.coast.slick > logic.coast.base * 1.15 && logic.coast.base > logic.coast.rough * 1.5, JSON.stringify(logic.coast));
check('speed cap held', logic.speed <= 6.25 && logic.speed > 4, logic.speed.toFixed(3));
check('substeps still run', logic.substeps >= 20, String(logic.substeps));
check('fall loses one life and respawns', logic.fall.placed && logic.fall.lives1 === logic.fall.lives0 - 1 && logic.fall.gameOver === false && logic.fall.nearStart, JSON.stringify(logic.fall));
check('respawn keeps the same surface', logic.fall.sameSurface === true);
check('next level regenerates surface', logic.nextSurface === true);
check('last life ends the run', logic.gameOver.lives === 0 && logic.gameOver.gameOver === true, JSON.stringify(logic.gameOver));
check('reaching the exit wins', logic.won === true);
check('black hole does not pull the ball', logic.hole.dx > 0.35 && logic.hole.dz > 0.35 && logic.hole.vx > 0 && logic.hole.vz > 0, JSON.stringify(logic.hole));
check('ball can leave the spawn cell', logic.leave.d > 0.25 && logic.leave.pen === 0 && logic.leave.finite, JSON.stringify(logic.leave));
check('high level rounded walls', logic.roam.walls && logic.roam.walls.fillet >= 0.028 && logic.roam.walls.cornerGap > 0.012 && logic.roam.walls.verts > logic.roam.walls.walls * 60, JSON.stringify(logic.roam.walls));
check('roam does not tunnel', logic.roam.pen === 0 && logic.roam.finite, JSON.stringify(logic.roam));
check('jade caustic shading changes with time', logic.caustic > 8, String(logic.caustic));
check('jade pixel stays green and opaque', logic.jadePx[1] > logic.jadePx[0] + 4 && logic.jadePx[1] > logic.jadePx[2] && logic.jadePx[1] > 12 && logic.jadePx[1] < 210 && logic.jadePx[3] === 255, JSON.stringify(logic.jadePx));

await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
const reduced = await page.evaluate(() => getComputedStyle(document.getElementById('sheet')).transitionDuration);
check('reduced motion removes sheet travel', parseFloat(reduced) < 0.05, reduced);
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__maze);
const desktop = await page.evaluate(() => {
  window.__maze.buildLevel(3);
  window.__maze.fitCamera();
  window.__maze.pump(0.2);
  const r = document.getElementById('startBtn').getBoundingClientRect();
  return { h: r.height, walls: window.__maze.getState().walls, theme: window.__maze.getTheme() };
});
check('desktop viewport still runs', desktop.walls > 10 && desktop.h >= 44, JSON.stringify(desktop));

check('no page or console errors', errors.length === 0, errors.slice(0, 6).join(' | '));

await mkdir(shotsDir, { recursive: true });
await page.setViewport(iphone);
await page.evaluate(() => {
  const m = window.__maze;
  m.setTheme('wood');
  m.buildLevel(1);
  m.startPlay();
  m.step(0.05);
  m.fitCamera();
  m.pump(0.3);
  document.getElementById('overlay').classList.add('hidden');
  document.getElementById('hint').style.opacity = '0';
});
await page.screenshot({ path: join(shotsDir, 'phone-ui.png') });

await page.evaluate(() => {
  const m = window.__maze;
  m.setTheme('jade');
  m.buildLevel(4);
  m.startPlay();
  m.step(0.05);
  m.fitCamera();
  m.pump(1.6);
  document.getElementById('overlay').classList.add('hidden');
  document.getElementById('hint').style.opacity = '0';
});
await page.screenshot({ path: join(shotsDir, 'phone-jade.png') });

await page.evaluate(() => {
  const m = window.__maze;
  m.setTheme('marble');
  m.buildLevel(8);
  m.startPlay();
  m.step(0.05);
  m.fitCamera();
  m.pump(0.5);
  document.getElementById('overlay').classList.add('hidden');
  document.getElementById('hint').style.opacity = '0';
});
await page.screenshot({ path: join(shotsDir, 'phone-surface.png') });

await page.evaluate(() => {
  const el = document.getElementById('sheet');
  el.style.transition = 'none';
  window.__maze.openSettings();
});
await page.screenshot({ path: join(shotsDir, 'phone-settings.png') });

await page.evaluate(() => {
  window.__maze.closeSettings();
  window.__maze.setTheme('jade');
  window.__maze.focusCorner();
  window.__maze.pump(1.7);
  document.getElementById('hint').style.opacity = '0';
});
await page.screenshot({ path: join(shotsDir, 'phone-rounds.png') });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (errors.length) console.log('errors:\n' + errors.join('\n'));
await browser.close();
server.close();
if (failed.length || errors.length) process.exit(1);
