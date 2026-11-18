// Combat playtest: flies an armed aircraft at a compound in headless Chromium, takes
// fire, releases flares, shoots the compound down to a ruin, and saves screenshots
// to tests/e2e/out/.
//
//   node tests/e2e/combat.mjs [--seed=424242] [--aircraft=attack]
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
const seed = args.seed ?? '424242';
const aircraft = args.aircraft ?? 'attack';

const server = await createServer({ root, logLevel: 'error', server: { port: 5198, strictPort: false } });
await server.listen();
const url = `${server.resolvedUrls.local[0]}?seed=${seed}&quality=medium&aircraft=${aircraft}&autostart=1&hour=11&weather=clear`;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

let failed = false;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed = true;
};
const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) });
const wait = (ms) => page.waitForTimeout(ms);
const ready = () => page.waitForFunction(() => window.__game.ready, null, { timeout: 90000 });

try {
  await page.goto(url);
  await ready();
  await wait(1500);
  // The nearest compound with a SAM site.
  const site = await page.evaluate(() => {
    const g = window.__game;
    const c = g.combat.active.filter((q) => q.parts.some((p) => p.type.weapon === 'sam')).sort((a, b) => a.dist - b.dist)[0] ?? g.combat.active[0];
    return c && { x: c.site.x, y: c.site.y, z: c.site.z, name: c.site.name, id: c.site.id };
  });
  check(!!site, 'compounds are generated near the start', site?.name);
  if (!site) throw new Error('no compound');

  // Hover 1.3 km south of it, nose on the compound: it should open fire.
  await page.evaluate((s) => window.__game.setPose(s.x, s.z + 1300, 120, 0, 0), site);
  await ready();
  await page.evaluate(() => {
    const g = window.__game;
    g.sim.keyDown('KeyX');
    setTimeout(() => g.sim.keyUp('KeyX'), 60);
  });
  await wait(6000);
  const engaged = await page.evaluate(() => {
    const g = window.__game;
    return { threats: g.combat.threats.length, sam: g.combat.samLocking, incoming: g.combat.incoming, health: +g.sim.heli.health.toFixed(2) };
  });
  check(engaged.threats > 0 || engaged.sam || engaged.incoming > 0, 'the compound engages inside its radius', JSON.stringify(engaged));
  await shot('combat_engaged');

  // Wait for a SAM, then flares.
  const launched = await page.waitForFunction(() => window.__game.combat.incoming > 0, null, { timeout: 20000 }).then(() => true, () => false);
  check(launched, 'a surface-to-air missile is launched');
  if (launched) {
    await wait(900);
    await shot('combat_sam');
    await page.evaluate(() => window.__game.releaseFlares());
    await wait(450);
    await shot('combat_flares');
    const flares = await page.evaluate(() => ({ left: window.__game.combat.flaresLeft, inAir: window.__game.combat.flares.length }));
    check(flares.inAir > 0 && flares.left < 60, 'K releases flares', JSON.stringify(flares));
  }

  // Closer and higher, over the ridge, for the attack.
  await page.evaluate((s) => window.__game.setPose(s.x, s.z + 800, 200, 0, 0), site);
  await ready();
  await page.evaluate(() => {
    const g = window.__game;
    g.sim.keyDown('KeyX');
    setTimeout(() => g.sim.keyUp('KeyX'), 60);
  });

  // Cockpit view, eyes on the compound: guns, then missiles until it falls.
  const result = await page.evaluate(async (s) => {
    const g = window.__game;
    g.rig.mode = 'cockpit';
    g.rig.looking = true;
    const t0 = performance.now();
    let destroyedAt = -1, fired = 0, launched = 0, raiding = null;
    const take = g.combat.takeEvents.bind(g.combat);
    g.combat.takeEvents = () => {
      const e = take();
      launched += e.filter((x) => x.type === 'missileLaunch' && !x.enemy).length;
      return e;
    };
    const card = document.querySelector('.target-card');
    const cardState = () => ({ on: card.classList.contains('on'), status: card.querySelector('.status').textContent, top: card.getBoundingClientRect().top / innerHeight });
    while (performance.now() - t0 < 45000) {
      const c = g.combat.compounds.get(s.id);
      if (!raiding && card.classList.contains('on')) raiding = cardState();
      if (c.destroyed) {
        destroyedAt = performance.now() - t0;
        break;
      }
      const target = c.parts.find((p) => !p.dead) ?? c.parts[0];
      const h = g.sim.heli;
      const dx = target.cx - h.pos.x, dy = target.cy - h.pos.y, dz = target.cz - h.pos.z;
      // Turn the head until the target sits under the reticle (the centre of the cockpit view).
      void dx; void dy; void dz;
      const cam = g.engine.camera, o = g.engine.origin;
      const v = new cam.position.constructor(target.cx - o.x, target.cy, target.cz - o.z).project(cam);
      if (v.z < 1) {
        g.rig.lookYaw -= v.x * 0.5;
        g.rig.lookPitch += v.y * 0.4;
      } else g.rig.lookYaw += 0.3;
      const t = performance.now() - t0;
      g.gunHeld = t > 1500 && t < 6000;
      // One at a time, as a pilot would: the next once the last has struck.
      const inFlight = g.combat.missiles.some((m) => !m.enemy && m.alive);
      if (g.combat.lock.locked && g.combat.missilesLeft > 0 && !inFlight) {
        g.fireMissile();
        fired++;
      }
      if (g.combat.missilesLeft === 0) g.combat.missilesLeft = 8;
      // Keep the test aircraft flying; this run is about the shooting.
      if (h.health < 0.5) h.health = 1;
      h.tailRotorOk = true;
      await new Promise((r) => setTimeout(r, 100));
    }
    g.gunHeld = false;
    await new Promise((r) => setTimeout(r, 400));
    const secured = cardState();
    return { destroyedAt, fired, launched, ammo: g.combat.gunAmmo, raiding, secured };
  }, site);
  check(result.ammo < 600, 'the gun fires', `${600 - result.ammo} rounds`);
  check(result.fired > 0, 'missiles lock and fire', `${result.fired} missiles`);
  check(result.destroyedAt > 0, 'the compound is destroyed', `${(result.destroyedAt / 1000).toFixed(1)} s, ${result.launched} missiles launched`);
  check(result.launched > 0 && result.launched <= 5, 'missiles are decisive: a handful takes a compound down', `${result.launched}`);
  check(result.raiding?.on && result.raiding.status === 'Raiding' && result.raiding.top < 0.2, 'the compound card sits at the top and reads "Raiding"', JSON.stringify(result.raiding));
  check(result.secured.on && result.secured.status === 'Secured', 'the card turns to "Secured" when the compound falls', JSON.stringify(result.secured));

  // The big one, from outside.
  await page.evaluate(() => {
    const g = window.__game;
    g.rig.mode = 'chase';
    g.rig.looking = true;
    // Off to one side so the aircraft does not hide the blast.
    g.rig.lookYaw = 0.75;
    g.rig.lookPitch = -0.28;
  });
  let elapsed = 0;
  for (const [t, name] of [[80, 'boom_0'], [450, 'boom_1'], [1000, 'boom_2'], [2300, 'boom_3'], [7000, 'boom_4']]) {
    await wait(t - elapsed);
    elapsed = t;
    await shot(name);
  }
  const dead = await page.evaluate((id) => window.__game.combat.compounds.get(id).destroyed, site.id);
  check(dead, 'compound stays a ruin');
  const cardGone = await page.evaluate(() => !document.querySelector('.target-card').classList.contains('on'));
  check(cardGone, 'the compound card clears a few seconds after the compound falls');
  // Showcase: watch another compound go up from off its flank.
  const other = await page.evaluate(() => {
    const g = window.__game;
    const c = g.combat.active.filter((q) => !q.destroyed).sort((a, b) => a.dist - b.dist)[0];
    if (!c) return null;
    const s = c.site;
    const hx = s.x + 380, hz = s.z + 560;
    const bearing = Math.atan2(s.x - hx, -(s.z - hz));
    g.setPose(hx, hz, 110, ((bearing + 0.5) * 180) / Math.PI, 0);
    return s.id;
  });
  if (other) {
    await ready();
    await page.evaluate(() => {
      const g = window.__game;
      g.sim.keyDown('KeyX');
      setTimeout(() => g.sim.keyUp('KeyX'), 60);
    });
    await wait(2500);
    await shot('compound_close');
    await page.evaluate((id) => {
      const g = window.__game;
      g.combat.destroyCompound(g.combat.compounds.get(id));
    }, other);
    let t0 = 0;
    for (const [t, name] of [[120, 'mega_0'], [600, 'mega_1'], [1300, 'mega_2'], [2600, 'mega_3'], [5000, 'mega_4'], [12000, 'mega_5']]) {
      await wait(t - t0);
      t0 = t;
      await page.evaluate(() => {
        const h = window.__game.sim.heli;
        h.health = 1;
        h.tailRotorOk = true;
      });
      await shot(name);
    }
  }

  const fps = await page.evaluate(async () => {
    const g = window.__game;
    const f0 = g.frames, t0 = performance.now();
    await new Promise((r) => setTimeout(r, 2000));
    return ((g.frames - f0) / (performance.now() - t0)) * 1000;
  });
  console.log(`INFO  frame rate in the aftermath  ${fps.toFixed(0)} fps`);
  check(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL ', String(e));
  failed = true;
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
