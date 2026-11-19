// Multiplayer end-to-end: two pilots in separate browsers on the same seed, through a relay
// running locally (`npm run dev` in relay/). Checks they see each other, that a wreck made by
// one shows for the other (even for a compound the other has not reached yet), that a late
// joiner gets the wrecks, and saves a screenshot of one aircraft seen from the other.
//
//   node tests/e2e/multiplayer.mjs
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(here, 'out');
mkdirSync(out, { recursive: true });

const relay = await fetch('http://localhost:8787/').then((r) => r.ok, () => false);
if (!relay) {
  console.log('FAIL  relay not running: start it with `npm run dev` in relay/');
  process.exit(1);
}

const server = await createServer({ root, logLevel: 'error', server: { port: 5198, strictPort: false } });
await server.listen();
const seed = 'mp-' + Math.random().toString(36).slice(2, 8);
const url = `${server.resolvedUrls.local[0]}?seed=${seed}&quality=low&online=1&autostart=1`;

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
let failed = false;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed = true;
};

async function pilot(name) {
  // A context each, so each has its own saved settings (callsign).
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((n) => localStorage.setItem('helisim.settings.v1', JSON.stringify({ callsign: n, quality: 'low' })), name);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => window.__game?.ready && window.__net()?.client.status === 'online', null, { timeout: 90000 });
  return { page, errors, ctx };
}

const peers = (p) => p.page.evaluate(() => [...window.__net().peers.values()].map((q) => ({ name: q.name, shown: q.shown, x: q.x, z: q.z })));

try {
  const a = await pilot('Alpha');
  const b = await pilot('Bravo');
  check(true, 'two pilots load and connect');

  // Park Bravo 40 m in front of Alpha's nose, both hovering.
  const at = await a.page.evaluate(() => {
    const g = window.__game, p = g.sim.heli.pos;
    g.setPose(p.x, p.z, 60, 0, 0);
    return { x: p.x, z: p.z };
  });
  await b.page.evaluate((s) => window.__game.setPose(s.x, s.z - 40, 62, 180, 0), at);
  await a.page.waitForFunction(() => [...window.__net().peers.values()].some((q) => q.shown), null, { timeout: 10000 });
  const seenByA = await peers(a);
  const seenByB = await peers(b);
  check(seenByA.length === 1 && seenByA[0].name === 'Bravo', 'Alpha sees Bravo', JSON.stringify(seenByA[0]?.name));
  check(seenByB.length === 1 && seenByB[0].name === 'Alpha', 'Bravo sees Alpha', JSON.stringify(seenByB[0]?.name));
  await a.page.waitForTimeout(1500);
  const where = await a.page.evaluate(() => {
    const q = [...window.__net().peers.values()][0], g = window.__game;
    return { dz: q.z - g.sim.heli.pos.z, dx: q.x - g.sim.heli.pos.x, mesh: !!q.view?.model.root.visible };
  });
  check(Math.abs(where.dz + 40) < 3 && Math.abs(where.dx) < 3 && where.mesh, 'Bravo is drawn where Bravo is', `dx ${where.dx.toFixed(1)} dz ${where.dz.toFixed(1)}`);
  await a.page.screenshot({ path: join(out, 'mp-alpha-sees-bravo.png') });
  check(await a.page.$eval('.marker.pilot span', (s) => s.textContent.startsWith('Bravo')).catch(() => false), 'name tag over Bravo');

  // Alpha flies to the nearest compound and wrecks one part, then the whole compound.
  const site = await a.page.evaluate(async () => {
    const g = window.__game;
    const c = g.debugCompound();
    if (!c) return null;
    g.setPose(c.x, c.z + 600, 150, 0, 0);
    await new Promise((r) => setTimeout(r, 2500));
    const cs = [...g.combat.compounds.values()].find((k) => k.site.name === c.name);
    g.combat.damagePart(cs, cs.parts[0], 1e6, true);
    return { id: cs.site.id, x: cs.site.x, z: cs.site.z, name: cs.site.name };
  });
  check(!!site, 'Alpha finds a compound', site?.name);
  await b.page.waitForTimeout(800);
  const bHasIt = await b.page.evaluate((id) => window.__game.combat.compounds.has(id), site.id);
  // Bravo goes there and should find the part already wrecked.
  await b.page.evaluate((s) => window.__game.setPose(s.x + 300, s.z + 600, 150, 0, 0), site);
  await b.page.waitForFunction((id) => window.__game.combat.compounds.has(id), site.id, { timeout: 15000 });
  const bPart = await b.page.evaluate((id) => window.__game.combat.compounds.get(id).parts[0].dead, site.id);
  check(bPart, 'Bravo arrives to find the part Alpha destroyed', bHasIt ? '(already loaded)' : '(compound loaded after the wreck)');

  // Now both have it loaded: Alpha brings the compound down and Bravo sees it fall live.
  await a.page.evaluate((id) => window.__game.combat.destroyCompound(window.__game.combat.compounds.get(id)), site.id);
  await b.page.waitForFunction((id) => window.__game.combat.compounds.get(id).destroyed, site.id, { timeout: 5000 }).then(
    () => check(true, 'Bravo sees the compound fall'),
    () => check(false, 'Bravo sees the compound fall'),
  );
  const counts = await Promise.all([a, b].map((p) => p.page.evaluate(() => window.__game.combat.destroyedCount)));
  check(counts[0] === 1 && counts[1] === 0, 'only Alpha is credited with it', `Alpha ${counts[0]}, Bravo ${counts[1]}`);

  // A late joiner gets the wrecks on arrival.
  const c = await pilot('Charlie');
  await c.page.evaluate((s) => window.__game.setPose(s.x - 300, s.z + 600, 150, 0, 0), site);
  await c.page.waitForFunction((id) => window.__game.combat.compounds.has(id), site.id, { timeout: 15000 });
  const cSees = await c.page.evaluate((id) => window.__game.combat.compounds.get(id).destroyed, site.id);
  check(cSees, 'late joiner finds the compound already destroyed');
  check((await peers(c)).length === 2, 'late joiner sees both pilots');

  // Leaving: Bravo closes, the others drop Bravo.
  await b.ctx.close();
  await a.page.waitForFunction(() => window.__net().peers.size === 1, null, { timeout: 10000 }).then(
    () => check(true, 'a pilot who leaves disappears for the others'),
    () => check(false, 'a pilot who leaves disappears for the others'),
  );
  // Going offline from the menu drops the connection.
  await a.page.evaluate(() => window.__menu.host.goOffline());
  check(await a.page.evaluate(() => window.__net() === null), 'going offline drops the connection');

  const errs = [...a.errors, ...c.errors, ...b.errors];
  check(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' | '));
} catch (e) {
  check(false, 'test ran to the end', String(e));
} finally {
  await browser.close();
  await server.close();
}
console.log(failed ? 'SOME CHECKS FAILED' : 'all passed');
process.exit(failed ? 1 : 0);
