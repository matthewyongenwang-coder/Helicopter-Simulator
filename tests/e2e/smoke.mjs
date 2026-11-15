// End-to-end smoke test: loads the game in headless Chromium, checks for console
// errors, measures frame rate, and saves screenshots to tests/e2e/out/.
//
//   node tests/e2e/smoke.mjs [--seed=NAME] [--quality=medium] [--shots=name:x,z,alt,heading;...]
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(here, 'out');
mkdirSync(out, { recursive: true });

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const seed = args.seed ?? 'smoke';
const quality = args.quality ?? 'medium';
const extra = args.query ? '&' + args.query : '';

const server = await createServer({ root, logLevel: 'error', server: { port: 5199, strictPort: false } });
await server.listen();
const url = `${server.resolvedUrls.local[0]}?seed=${seed}&quality=${quality}${extra}`;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

let failed = false;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed = true;
};

try {
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 90000 });
  check(true, 'game loads and first terrain is ready', `${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const info = await page.evaluate(() => {
    const g = window.__game;
    const gl = g.engine.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
      reversedDepth: g.engine.renderer.capabilities.reversedDepthBuffer,
      seed: g.world.seed,
    };
  });
  console.log('renderer:', info.renderer, '| reversed depth:', info.reversedDepth, '| seed:', info.seed);

  const measureFps = async (seconds) =>
    page.evaluate(
      (s) =>
        new Promise((resolve) => {
          const g = window.__game;
          const f0 = g.frames, t = performance.now();
          setTimeout(() => resolve(((g.frames - f0) * 1000) / (performance.now() - t)), s * 1000);
        }),
      seconds,
    );

  const shots = (args.shots ?? 'ground:,,0,0;low:,,120,40;high:,,900,200').split(';');
  for (const shot of shots) {
    const [name, rest] = shot.split(':');
    const [x, z, alt, hdg] = rest.split(',');
    await page.evaluate(
      ([x, z, alt, hdg]) => {
        const g = window.__game;
        const p = g.sim.heli.pos;
        const px = x === '' ? p.x : Number(x), pz = z === '' ? p.z : Number(z);
        if (Number(alt) > 0 || x !== '') g.setPose(px, pz, Number(alt), Number(hdg));
      },
      [x, z, alt, hdg],
    );
    // Let the camera settle and the terrain stream in.
    await page.waitForTimeout(600);
    await page.waitForFunction(() => window.__game.terrain.settled, null, { timeout: 60000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(out, `${name}.png`) });
    const fps = await measureFps(2);
    const st = await page.evaluate(() => ({ ...window.__game.terrain.stats, y: window.__game.sim.heli.pos.y }));
    console.log(`shot ${name}: ${fps.toFixed(0)} fps, ${st.shown} nodes, ${(st.triangles / 1000).toFixed(0)}k tris, y=${st.y.toFixed(0)}`);
    check(fps > 25, `frame rate at "${name}"`, `${fps.toFixed(0)} fps`);
  }
  // Cruise: 45 s at 85 m/s (165 kt, 3.8 km), low, watching that terrain streams in ahead of the aircraft.
  if (args.cruise !== '0') {
    const before = await page.evaluate(() => {
      const g = window.__game;
      const p = g.sim.heli.pos;
      g.setPose(p.x, p.z, 150, 90, 85);
      return { geometries: g.engine.renderer.info.memory.geometries, ox: g.engine.origin.x, x: p.x };
    });
    await page.waitForFunction(() => window.__game.terrain.settled, null, { timeout: 60000 });
    const cruise = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const g = window.__game;
          const f0 = g.frames, t0 = performance.now();
          let minLag = Infinity, maxPending = 0, maxGeo = 0, holes = 0, samples = 0;
          const h = g.sim.heli;
          const timer = setInterval(() => {
            // Keep it level and fast; this is a streaming test, not a flying test.
            h.vel.set(85, 0, 0);
            h.pos.y = Math.max(h.pos.y, 150);
            minLag = Math.min(minLag, g.terrain.stats.lag);
            maxPending = Math.max(maxPending, g.pool.pending);
            maxGeo = Math.max(maxGeo, g.engine.renderer.info.memory.geometries);
            if (g.terrain.stats.shown === 0) holes++;
            samples++;
            if (performance.now() - t0 > 45000) {
              clearInterval(timer);
              resolve({ fps: ((g.frames - f0) * 1000) / (performance.now() - t0), minLag, maxPending, maxGeo, holes, samples, x: h.pos.x, ox: g.engine.origin.x });
            }
          }, 50);
        }),
    );
    await page.screenshot({ path: join(out, 'cruise.png') });
    console.log(
      `cruise: ${cruise.fps.toFixed(0)} fps, flew ${((cruise.x - before.x) / 1000).toFixed(1)} km, worst LOD lag ${cruise.minLag.toFixed(2)}, max queue ${cruise.maxPending}, geometries ${before.geometries} → max ${cruise.maxGeo}`,
    );
    check(cruise.fps > 25, 'frame rate in a 165 kt cruise', `${cruise.fps.toFixed(0)} fps`);
    check(cruise.x - before.x > 3500, 'aircraft covered ground');
    check(cruise.ox !== before.ox, 'floating origin re-centred during the flight', `${before.ox} → ${cruise.ox}`);
    check(cruise.minLag > 0.6, 'terrain detail arrives before it is needed', `worst lag ratio ${cruise.minLag.toFixed(2)} (1 = on time)`);
    check(cruise.holes === 0, 'no frame without terrain');
    check(cruise.maxGeo < before.geometries * 1.5 + 50, 'GPU geometry count stays bounded', `${cruise.maxGeo}`);
  }
  check(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  check(false, 'run completed', String(e));
  if (errors.length) console.log('console errors:', errors.slice(0, 8).join('\n'));
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
