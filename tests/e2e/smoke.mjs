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
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-precise-memory-info'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
page.on('crash', () => console.log('PAGE CRASHED'));
page.on('framenavigated', (f) => { if (f === page.mainFrame() && args.verbose) console.log('navigated', f.url()); });

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

  // Spawn menu: every aircraft is listed with its specs, selecting one shows its model, Fly starts the flight.
  if (args.menu !== '0') {
    await page.waitForSelector('#menu.open');
    const rows = await page.$$eval('#menu [aria-label="Aircraft"] .row', (r) => r.map((n) => n.textContent));
    check(rows.length === 7, 'menu lists all seven aircraft', rows.join(' | '));
    const table = await page.$eval('#menu .specs table', (t) => ({ rows: t.querySelectorAll('tbody tr').length, cols: t.querySelectorAll('thead th').length }));
    check(table.rows >= 12 && table.cols === 8, 'spec table compares all seven', `${table.rows} rows x ${table.cols - 1} aircraft`);
    const pads = await page.$$eval('#menu [aria-label="Start location"] .row', (r) => r.map((n) => n.textContent));
    check(pads.length >= 3 && pads.some((p) => p.includes('Free flight')), 'menu offers helipads and free flight', `${pads.length} choices`);
    const seedShown = await page.$eval('#menu .seed input', (i) => i.value);
    check(/^[2-9A-Z]{4}-[2-9A-Z]{3}$/.test(seedShown), 'seed is shown on screen', seedShown);
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(out, 'menu.png') });
    const count = (await page.$$('#menu [aria-label="Aircraft"] .row')).length;
    for (let i = 0; i < count; i++) {
      await (await page.$$('#menu [aria-label="Aircraft"] .row'))[i].click();
      await page.waitForFunction(() => window.__game.ready, null, { timeout: 60000 });
      await page.waitForTimeout(350);
      const id = await page.evaluate(() => window.__game.aircraft.id);
      await page.evaluate(() => (document.getElementById('menu').style.visibility = 'hidden'));
      await page.screenshot({ path: join(out, `model_${id}.png`) });
      await page.evaluate(() => (document.getElementById('menu').style.visibility = ''));
    }
    await (await page.$$('#menu [aria-label="Aircraft"] .row'))[2].click();
    await page.click('#menu .btn.primary');
    await page.waitForFunction(() => window.__game.mode === 'fly' && window.__game.ready, null, { timeout: 60000 });
    const flying = await page.evaluate(() => ({ menu: document.getElementById('menu').classList.contains('open'), id: window.__game.aircraft.id }));
    check(!flying.menu && flying.id === 'medium', 'Fly closes the menu and starts in the chosen aircraft', JSON.stringify(flying));
  } else {
    await page.evaluate(() => {
      window.__menu.close();
      window.__game.setMode('fly');
    });
  }

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
    await page.waitForFunction(() => window.__game.ready && window.__game.terrain.settled && window.__game.props.settled, null, { timeout: 60000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(out, `${name}.png`) });
    const fps = await measureFps(2);
    const st = await page.evaluate(() => ({ ...window.__game.terrain.stats, y: window.__game.sim.heli.pos.y }));
    console.log(`shot ${name}: ${fps.toFixed(0)} fps, ${st.shown} nodes, ${(st.triangles / 1000).toFixed(0)}k tris, y=${st.y.toFixed(0)}`);
    check(fps > 25, `frame rate at "${name}"`, `${fps.toFixed(0)} fps`);
  }
  // Milestone 5: HUD, weather, downwash, damage, cockpit, controls overlay, pause.
  if (args.m5 !== '0') {
    const settle = async (ms = 600) => {
      await page.waitForTimeout(ms);
      await page.waitForFunction(() => window.__game.ready && window.__game.terrain.settled && window.__game.props.settled, null, { timeout: 90000 });
    };
    const hudText = await page.$eval('#ui', (n) => n.textContent);
    check(/IAS/.test(hudText) && /ALT/.test(hudText) && /Seed/.test(hudText), 'HUD shows airspeed, altitude and the seed');
    // Find open water and open grass near the start for downwash.
    const spots = await page.evaluate(() => {
      const g = window.__game, p = g.sim.heli.pos, w = g.world;
      let water = null, land = null;
      for (let r = 300; r < 15000 && (!water || !land); r += 150) {
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * Math.PI * 2, x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
          const h = w.height(x, z);
          if (!water && h < -8 && w.height(x + 60, z) < -8 && w.height(x - 60, z) < -8) water = { x, z };
          if (!land && h > 4 && w.density(x, z) < 0.01 && Math.abs(w.height(x + 20, z) - h) < 1 && Math.abs(w.height(x, z + 20) - h) < 1) land = { x, z };
        }
      }
      return { water, land };
    });
    const hover = async (name, spot, alt, hour, weather) => {
      await page.evaluate(([x, z, alt, hour, weather]) => {
        const g = window.__game;
        g.weather.setMode(weather, true);
        g.weather.hour = hour;
        g.setPose(x, z, alt, 30);
      }, [spot.x, spot.z, alt, hour, weather]);
      await settle();
      await page.keyboard.press('KeyX');
      await page.waitForTimeout(2500);
      await page.screenshot({ path: join(out, `${name}.png`) });
      const fps = await measureFps(1.5);
      check(fps > 25, `frame rate at "${name}"`, `${fps.toFixed(0)} fps`);
      await page.keyboard.press('KeyX');
      await page.waitForTimeout(200);
    };
    if (spots.water) await hover('wash_water', spots.water, 6, 11, 'clear');
    if (spots.land) await hover('wash_land', spots.land, 5, 16, 'fair');
    const base = spots.land ?? spots.water;
    if (base) {
      const auto = await page.evaluate(() => window.__game.sim.heli.autohover.engaged);
      check(auto === false, 'autohover toggles off again with X');
      await hover('storm', base, 160, 15, 'storm');
      const rain = await page.evaluate(() => window.__game.effects.rain.visible);
      check(rain, 'rain falls in the storm');
      await hover('snow', base, 90, 11, 'snow');
      await hover('fog', base, 60, 9, 'fog');
      await hover('clouds_dusk', base, 700, 18.4, 'fair');
      await hover('above_clouds', base, 2600, 13, 'overcast');
      // Wind and area turbulence reach the flight model.
      await page.evaluate(() => window.__game.weather.setMode('storm', true));
      await page.waitForTimeout(300);
      const air = await page.evaluate(() => ({ wind: Math.hypot(window.__game.env.wind_.x, window.__game.env.wind_.z), gust: window.__game.env.wind_.gust }));
      check(air.wind > 3 && air.gust > 3, 'storm wind and gusts reach the flight model', `${air.wind.toFixed(1)} m/s, gust ${air.gust}`);
      await page.evaluate(() => window.__game.weather.setMode('fair', true));
      // Damage: smoke at low health, then fire, then destroyed.
      await page.evaluate(([x, z]) => {
        const g = window.__game;
        g.weather.hour = 12;
        g.setPose(x, z, 120, 0);
      }, [base.x, base.z]);
      await settle();
      await page.evaluate(() => (window.__game.sim.heli.health = 0.25));
      await page.waitForTimeout(2500);
      await page.screenshot({ path: join(out, 'damaged.png') });
      await page.evaluate(() => window.__game.sim.heli.destroy('Test'));
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(out, 'destroyed.png') });
      const banner = await page.$eval('.banner', (n) => getComputedStyle(n).display !== 'none');
      check(banner, 'crash banner offers a respawn');
      await page.keyboard.press('KeyR');
      await settle();
      const back = await page.evaluate(() => ({ destroyed: window.__game.sim.heli.destroyed, onGround: window.__game.sim.heli.tel.onGround }));
      check(!back.destroyed, 'R respawns at the last helipad', JSON.stringify(back));
    }
    // Mouse look: right turns the view right and up looks up, in the chase and the cockpit view.
    // Real mouse input: a click captures the mouse (or starts a drag where pointer lock is unavailable).
    const viewDir = () => page.evaluate(() => {
      const cam = window.__game.engine.camera, v = cam.getWorldDirection(new cam.position.constructor());
      return { yaw: Math.atan2(v.x, -v.z), y: v.y };
    });
    const lookTurn = async (dx, dy) => {
      await page.mouse.move(640, 360);
      await page.mouse.down();
      await page.waitForTimeout(200);
      const a = await viewDir();
      await page.mouse.move(640 + dx, 360 + dy, { steps: 8 });
      await page.waitForTimeout(400);
      const b = await viewDir();
      await page.mouse.up();
      const locked = await page.evaluate(() => document.pointerLockElement !== null);
      if (locked) await page.evaluate(() => document.exitPointerLock());
      await page.keyboard.press('KeyV');
      await page.waitForTimeout(900);
      let d = b.yaw - a.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      return { turn: d, up: b.y - a.y, locked };
    };
    for (const view of ['chase', 'cockpit']) {
      const right = await lookTurn(120, 0), up = await lookTurn(0, -80);
      check(right.turn > 0.2 && up.up > 0.05, `mouse look follows the mouse in the ${view} view`, `right → ${right.turn.toFixed(2)} rad, up → ${up.up.toFixed(2)}, pointer lock ${right.locked}`);
      if (view === 'chase') {
        await page.keyboard.press('KeyC');
        await page.waitForTimeout(300);
      }
    }
    await page.keyboard.press('KeyC');
    await page.waitForTimeout(300);
    // Cockpit view.
    await page.keyboard.press('KeyC');
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(out, 'cockpit.png') });
    const cam = await page.evaluate(() => window.__game.rig.mode);
    check(cam === 'cockpit', 'C switches to the cockpit camera');
    await page.keyboard.press('KeyC');
    // Controls overlay.
    await page.keyboard.press('KeyH');
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(out, 'controls.png') });
    const ov = await page.evaluate(() => ({ open: document.querySelector('.scrim').classList.contains('open'), paused: window.__game.paused, rows: document.querySelectorAll('.bind').length }));
    check(ov.open && ov.paused && ov.rows >= 18, 'H opens the controls overlay and pauses', JSON.stringify(ov));
    // Rebind collective up to K, check it works, then restore.
    await page.click('.bind button');
    await page.keyboard.press('KeyK');
    const rebound = await page.evaluate(() => window.__settings.bindings.collectiveUp.join(','));
    check(rebound === 'KeyK', 'controls can be rebound', rebound);
    await page.click('.sheet .foot .btn:not(.primary)');
    const restored = await page.evaluate(() => window.__settings.bindings.collectiveUp.join(','));
    check(restored === 'Space', 'reset restores the default bindings', restored);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const closed = await page.evaluate(() => !document.querySelector('.scrim').classList.contains('open') && !window.__game.paused);
    check(closed, 'Escape closes the overlay and resumes');
    // Minimap zoom.
    const z0 = await page.evaluate(() => window.__hud.minimap.zoom);
    await page.keyboard.press('KeyM');
    await page.waitForTimeout(200);
    const z1 = await page.evaluate(() => window.__hud.minimap.zoom);
    check(z1 !== z0, 'M changes the minimap zoom');
    // Pause menu keeps the flight.
    await page.evaluate(() => (window.__game.flightTime = Math.max(window.__game.flightTime, 1)));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const paused = await page.evaluate(() => ({ menu: document.getElementById('menu').classList.contains('open'), resume: getComputedStyle(document.querySelector('#menu .go .btn')).display !== 'none' }));
    check(paused.menu && paused.resume, 'Escape opens the menu with Resume');
    await page.screenshot({ path: join(out, 'pause.png') });
    await page.click('#menu .go .btn.primary');
    await page.waitForTimeout(300);
    const resumed = await page.evaluate(() => window.__game.mode);
    check(resumed === 'fly', 'Resume returns to the flight');
  }

  // Settlements, bridges and night lighting.
  if (args.world !== '0') {
    const targets = await page.evaluate(() => window.__game.debugTargets());
    const goto = async (name, x, z, alt, hdg, hour) => {
      await page.evaluate(([x, z, alt, hdg, hour]) => {
        const g = window.__game;
        g.weather.hour = hour;
        g.setPose(x, z, alt, hdg);
      }, [x, z, alt, hdg, hour]);
      await page.waitForTimeout(500);
      await page.waitForFunction(() => window.__game.ready && window.__game.terrain.settled && window.__game.props.settled, null, { timeout: 90000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(out, `${name}.png`) });
      const fps = await measureFps(2);
      const st = await page.evaluate(() => {
        const g = window.__game;
        return { ...g.props.stats, calls: g.engine.renderer.info.render.calls, tris: g.engine.renderer.info.render.triangles, colliders: g.env.colliders.count };
      });
      console.log(`shot ${name}: ${fps.toFixed(0)} fps, ${st.calls} draw calls, ${(st.tris / 1e6).toFixed(2)}M tris, ${st.structureCells} structure cells, ${st.forestCells} forest cells, ${st.colliders} colliders`);
      check(fps > 25, `frame rate at "${name}"`, `${fps.toFixed(0)} fps`);
      return st;
    };
    check(!!targets.city, 'a city exists within 40 km');
    check(!!targets.bridge, 'a bridge exists within 20 km', targets.bridge ? `${targets.bridge.span.toFixed(0)} m span` : '');
    if (targets.city) {
      const c = targets.city;
      const st = await goto('city', c.x - c.r * 0.75, c.z - c.r * 0.75, 230, 135, 10);
      check(st.colliders > 500, 'city buildings are solid', `${st.colliders} colliders`);
      // Street level: parked on the city heliport.
      const pad = await page.evaluate(([x, z]) => window.__game.helipads(x, z, 3000).find((p) => p.kind === 'ground'), [c.x, c.z]);
      check(!!pad, 'the city has a ground heliport', pad ? pad.name : '');
      if (pad) {
        await page.evaluate((pad) => {
          const g = window.__game;
          g.weather.hour = 15;
          g.spawn(g.aircraft, { x: pad.x, z: pad.z, y: pad.y, heading: pad.heading });
        }, pad);
        await page.waitForFunction(() => window.__game.ready && window.__game.props.settled, null, { timeout: 90000 });
        await page.waitForTimeout(2500);
        await page.screenshot({ path: join(out, 'city_street.png') });
        const rest = await page.evaluate(() => {
          const h = window.__game.sim.heli;
          return { onGround: h.tel.onGround, kind: h.tel.surfaceKind, health: h.health, y: h.pos.y, vy: h.vel.y };
        });
        check(rest.onGround && rest.health === 1 && Math.abs(rest.vy) < 0.05, 'aircraft rests on the helipad', JSON.stringify(rest));
      }
      await goto('city_night', c.x - c.r * 0.6, c.z + c.r * 0.5, 180, 50, 22);
      await goto('city_dusk', c.x + c.r * 0.9, c.z - c.r * 0.2, 320, 265, 18.4);
    }
    if (targets.town) await goto('town', targets.town.x - 500, targets.town.z + 350, 150, 60, 11);
    if (targets.bridge) {
      const b = targets.bridge;
      const rad = ((b.heading + 90) * Math.PI) / 180;
      await goto('bridge', b.x + Math.sin(rad) * 260, b.z - Math.cos(rad) * 260, 70, b.heading - 90, 14);
    }
    await page.evaluate(() => (window.__game.weather.hour = 10));
  }

  // Cruise: 45 s at 85 m/s (165 kt, 3.8 km), low, watching that terrain streams in ahead of the aircraft.
  if (args.cruise !== '0') {
    const before = await page.evaluate(() => {
      const g = window.__game;
      const p = g.sim.heli.pos;
      g.setPose(p.x, p.z, 150, 90, 85);
      return { geometries: g.engine.renderer.info.memory.geometries, ox: g.engine.origin.x, x: p.x };
    });
    await page.waitForFunction(() => window.__game.ready && window.__game.terrain.settled && window.__game.props.settled, null, { timeout: 60000 });
    before.geometries = await page.evaluate(() => {
      // The aircraft waited for the world to load: put the cruise speed back on.
      window.__game.sim.heli.vel.set(85, 0, 0);
      return window.__game.engine.renderer.info.memory.geometries;
    });
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
    // Leak check: visit the start, go 6 km away, and come back. Arriving at the same place
    // by the same route must cost the same number of GPU buffers both times.
    const visit = async (x) => {
      await page.evaluate(([x]) => {
        const g = window.__game;
        g.setPose(x, g.sim.heli.pos.z, 150, 90, 0);
      }, [x]);
      await page.waitForTimeout(500);
      await page.waitForFunction(() => window.__game.ready && window.__game.terrain.settled && window.__game.props.settled, null, { timeout: 60000 });
      await page.waitForTimeout(500);
      return page.evaluate(() => window.__game.engine.renderer.info.memory.geometries);
    };
    await visit(before.x + 6000);
    const first = await visit(before.x);
    await visit(before.x + 6000);
    const second = await visit(before.x);
    check(
      Math.abs(second - first) <= Math.max(4, first * 0.02),
      'no GPU geometry leak: the same trip costs the same twice',
      `${first} then ${second} geometries (peak ${cruise.maxGeo} en route)`,
    );
  }
  // Playtest with real key presses: start, lift off, autohover, fly forward, brake, descend and land.
  if (args.playtest !== '0') {
    // An open town helipad: downtown towers are no place for a scripted pilot.
    const padName = await page.evaluate(() => {
      const g = window.__game, p = g.sim.heli.pos;
      g.weather.setMode('fair', true);
      g.weather.hour = 10;
      const pads = g.helipads(p.x, p.z, 30000);
      const pad = pads.find((q) => q.kind === 'ground' && q.rank <= 2) ?? pads.find((q) => q.kind === 'ground');
      g.spawn(g.aircraft, { x: pad.x, z: pad.z, y: pad.y, heading: pad.heading, name: pad.name });
      return pad.name;
    });
    console.log('playtest from', padName);
    await page.waitForFunction(() => window.__game.ready, null, { timeout: 60000 });
    // Waits are in simulated seconds, so a slow or throttled frame rate does not change the flight.
    const simTime = () => page.evaluate(() => window.__game.sim.heli.time);
    const waitSim = async (ms) => {
      const end = (await simTime()) + ms / 1000;
      await page.waitForFunction((end) => window.__game.sim.heli.time >= end, end, { timeout: 180000, polling: 16 });
    };
    const st = () => page.evaluate(() => {
      const h = window.__game.sim.heli, t = h.tel;
      return { impact: t.lastImpact, why: h.destroyedReason, minVs: window.__minVs ?? 0, nr: t.rotorRpm, ralt: t.radarAlt, gs: t.groundSpeed, vs: t.verticalSpeed, tilt: Math.hypot(t.pitch, t.roll) * 57.3, onGround: t.onGround, health: h.health, engine: h.engine, auto: h.autohover.engaged, x: h.pos.x, z: h.pos.z, kind: t.surfaceKind };
    });
    const start = await st();
    await page.keyboard.press('KeyJ');
    const t0 = await simTime();
    await page.waitForFunction(() => window.__game.sim.heli.tel.rotorRpm >= 0.95, null, { timeout: 90000, polling: 16 });
    const spool = (await simTime()) - t0;
    check(spool > 8 && spool < 25, 'J starts the engine and the rotor spools up slowly', `${spool.toFixed(1)} s to the green`);
    await page.keyboard.down('Space');
    await page.waitForFunction(() => window.__game.sim.heli.tel.radarAlt > 25, null, { timeout: 30000 });
    await page.keyboard.up('Space');
    await page.keyboard.press('KeyX');
    await waitSim(3000);
    let s1 = await st();
    check(s1.auto && Math.abs(s1.vs) < 0.5 && s1.gs < 0.5, 'lift off with Space, X settles into a hover', `ralt ${s1.ralt.toFixed(1)} m, vs ${s1.vs.toFixed(2)}, gs ${s1.gs.toFixed(2)}`);
    await page.keyboard.down('KeyW');
    await waitSim(4000);
    s1 = await st();
    await page.keyboard.up('KeyW');
    check(s1.gs > 8, 'holding W flies forward', `${s1.gs.toFixed(1)} m/s`);
    await waitSim(7000);
    const s2 = await st();
    // Level apart from the few degrees of lean that hold it against the wind.
    check(s2.gs < 0.4 && s2.tilt < 5, 'releasing W brakes to a hover', `gs ${s2.gs.toFixed(2)}, tilt ${s2.tilt.toFixed(1)}°`);
    // Back over the pad: fly the reverse leg with S, then descend with Shift.
    // Back over the pad, flown like a pilot would with autohover on: cyclic pulses toward it,
    // let go, and let autohover brake. Forward is (sin h, −cos h), right is (cos h, sin h).
    for (let k = 0; k < 40; k++) {
      const p = await page.evaluate(() => {
        const h = window.__game.sim.heli;
        return { x: h.pos.x, z: h.pos.z, hd: h.tel.heading, gs: h.tel.groundSpeed };
      });
      const dx = start.x - p.x, dz = start.z - p.z;
      const fwd = dx * Math.sin(p.hd) - dz * Math.cos(p.hd);
      const right = dx * Math.cos(p.hd) + dz * Math.sin(p.hd);
      if (args.verbose) console.log(`  return: fwd ${fwd.toFixed(1)} right ${right.toFixed(1)} gs ${p.gs.toFixed(2)}`);
      if (Math.hypot(fwd, right) < 4 && p.gs < 0.5) break;
      const keys = [];
      if (Math.abs(fwd) > 1.5) keys.push([fwd > 0 ? 'KeyW' : 'KeyS', Math.min(2600, 350 + Math.abs(fwd) * 40)]);
      if (Math.abs(right) > 1.5) keys.push([right > 0 ? 'KeyD' : 'KeyA', Math.min(2000, 300 + Math.abs(right) * 35)]);
      for (const [key] of keys) await page.keyboard.down(key);
      const tStart = await simTime();
      for (const [key, ms] of keys.sort((a, b) => a[1] - b[1])) {
        await waitSim(Math.max(0, ms - ((await simTime()) - tStart) * 1000));
        await page.keyboard.up(key);
      }
      await waitSim(2200);
    }
    // Let down in steps, the way a pilot would: a short push on the lever, then let autohover hold.
    let landed = false;
    for (let k = 0; k < 50; k++) {
      const now = await st();
      if (args.verbose) console.log(`  descent: ralt ${now.ralt.toFixed(2)} vs ${now.vs.toFixed(2)} ground ${now.onGround}`);
      if (now.onGround) {
        landed = true;
        break;
      }
      await page.keyboard.down('ShiftLeft');
      await waitSim(Math.max(650, Math.min(1100, now.ralt * 45)));
      await page.keyboard.up('ShiftLeft');
      await waitSim(1400);
    }
    // On the ground: lever fully down.
    if (landed) {
      await page.keyboard.down('ShiftLeft');
      await waitSim(2500);
      await page.keyboard.up('ShiftLeft');
    }
    await waitSim(2000);
    const s3 = await st();
    await page.screenshot({ path: join(out, 'playtest_landed.png') });
    check(s3.onGround && s3.health === 1, 'Shift descends and lands without damage', `${JSON.stringify({ impact: s3.impact.toFixed(2), why: s3.why, onGround: s3.onGround, health: s3.health, kind: s3.kind, off: Math.hypot(s3.x - start.x, s3.z - start.z).toFixed(1) })}`);
  }

  // Soak: a long flight with the weather cycling fast, watching for growth in memory and GPU resources.
  if (args.soak) {
    const seconds = Number(args.soak);
    await page.evaluate(() => {
      const g = window.__game, h = g.sim.heli;
      g.weather.setMode('auto', true);
      g.setPose(h.pos.x, h.pos.z, 220, 0, 70);
      const soak = { t0: performance.now(), samples: [] };
      window.__soak = soak;
      soak.timer = setInterval(() => {
        const hh = g.sim.heli;
        const el = (performance.now() - soak.t0) / 1000;
        // Turn every 20 s so the flight covers new and old ground.
        const heading = Math.floor(el / 20) * 1.9;
        hh.vel.set(Math.sin(heading) * 70, 0, -Math.cos(heading) * 70);
        hh.pos.y = Math.max(hh.pos.y, g.env.ground(hh.pos.x, hh.pos.z) + 220);
        // Fast-forward the weather and the clock.
        g.weather.update(1.5, g.world, hh.pos.x, hh.pos.z, 200);
      }, 100);
    });
    const samples = [];
    const t0 = Date.now();
    while ((Date.now() - t0) / 1000 < seconds) {
      await page.waitForTimeout(5000);
      const smp = await page.evaluate(() => {
        const g = window.__game, m = g.engine.renderer.info.memory;
        return { heap: performance.memory ? performance.memory.usedJSHeapSize / 1e6 : 0, geo: m.geometries, tex: m.textures, cpu: g.cpuMs, x: g.sim.heli.pos.x, z: g.sim.heli.pos.z };
      });
      smp.t = (Date.now() - t0) / 1000;
      samples.push(smp);
      if (args.verbose) console.log(`  soak t=${smp.t.toFixed(0)} heap ${smp.heap.toFixed(0)} MB geo ${smp.geo} tex ${smp.tex} cpu ${smp.cpu.toFixed(1)}`);
    }
    await page.evaluate(() => clearInterval(window.__soak.timer));
    const s = samples;
    const third = Math.max(1, Math.floor(s.length / 3));
    const avg = (arr, k) => arr.reduce((a, b) => a + b[k], 0) / arr.length;
    const early = s.slice(third, 2 * third), late = s.slice(2 * third);
    const heapGrowth = avg(late, 'heap') - avg(early, 'heap');
    const maxGeo = Math.max(...s.map((x) => x.geo)), maxTex = Math.max(...s.map((x) => x.tex));
    console.log(`soak ${seconds}s: heap ${avg(early, 'heap').toFixed(0)} → ${avg(late, 'heap').toFixed(0)} MB, geometries max ${maxGeo}, textures max ${maxTex}, cpu ${avg(s, 'cpu').toFixed(1)} ms/frame`);
    check(heapGrowth < 40, 'no steady JS heap growth over a long flight', `${heapGrowth.toFixed(1)} MB between the middle and last third`);
    check(maxGeo < 900 && maxTex < 200, 'GPU resources stay bounded', `${maxGeo} geometries, ${maxTex} textures`);
  }

  const cpu = await page.evaluate(() => window.__game.cpuMs);
  console.log(`main-thread time per frame: ${cpu.toFixed(2)} ms`);
  check(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  check(false, 'run completed', String(e));
  if (errors.length) console.log('console errors:', errors.slice(0, 8).join('\n'));
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
