import { describe, expect, it } from 'vitest';
import { PVP } from '../../src/data/weapons';
import { Combat, type PilotTarget, type PlayerState } from '../../src/game/combat';
import { rng } from '../../src/world/rng';
import { World } from '../../src/world/world';

const world = new World(424242);
// One missile at a pilot crossing 1.8 km ahead at 50 m/s. With `g`, the pilot breaks sideways when
// the missile is `tgo` seconds out; with `jink`, it breaks one way first and flips hard the other way then.
function trial(g: number, tgo: number, side: number, seed: number, jink = false) {
  const combat = new Combat(world, { hit: () => {} }, rng(seed));
  combat.home = { x: 1e6, z: 1e6 };
  combat.arm('attack');
  const p: PlayerState = { x: 0, y: 600, z: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1, radius: 3, agl: 600, alive: true, fragility: 1 };
  const tgt: PilotTarget = { id: 1, x: -300, y: 620, z: -1800, vx: 50, vy: 0, vz: 0, radius: 3.2, alive: true };
  combat.pilots = [tgt];
  const ray = () => { const dx = tgt.x - p.x, dy = tgt.y - p.y, dz = tgt.z - p.z, l = Math.hypot(dx, dy, dz); return { ox: p.x, oy: p.y, oz: p.z, dx: dx / l, dy: dy / l, dz: dz / l }; };
  const dt = 1 / 120;
  let fired = false, breaking = false, hit = 0, ax = 0, az = 0;
  for (let t = 0; t < 20; t += dt) {
    const fire = !fired && combat.lock.locked;
    if (fire) fired = true;
    combat.update(dt, p, { gun: false, missile: fire, flares: false, ray: ray() }, true);
    combat.takeEvents();
    for (const h of combat.pvpHits) if (h.missile) hit = Math.max(hit, h.amount);
    combat.pvpHits.length = 0;
    const m = combat.missiles[0];
    if (fired && !m) break;
    if (m && !breaking && g > 0) {
      const d = Math.hypot(m.x - tgt.x, m.y - tgt.y, m.z - tgt.z);
      if (d / Math.max(80, m.speed) < tgo) {
        breaking = true;
        // Break across the missile's path (horizontal, perpendicular to its heading).
        const l = Math.hypot(m.dx, m.dz) || 1;
        ax = (-m.dz / l) * side * g * 9.81; az = (m.dx / l) * side * g * 9.81;
      }
    }
    // Jink: break one way early, then flip hard the other way when the missile is `tgo` out.
    if (jink && m && !breaking) {
      const d = Math.hypot(m.x - tgt.x, m.y - tgt.y, m.z - tgt.z);
      const l = Math.hypot(m.dx, m.dz) || 1;
      if (d / Math.max(80, m.speed) < 5) { tgt.vx += (-m.dz / l) * side * g * 9.81 * dt; tgt.vz += (m.dx / l) * side * g * 9.81 * dt; }
    }
    if (breaking && jink) { tgt.vx -= ax * 2 * dt; tgt.vz -= az * 2 * dt; }
    else if (breaking) { tgt.vx += ax * dt; tgt.vz += az * dt; }
    tgt.x += tgt.vx * dt; tgt.y += tgt.vy * dt; tgt.z += tgt.vz * dt;
  }
  return hit;
}

describe('dodging missiles', () => {
  it('a pilot who holds course is hit, and hard', () => {
    for (const seed of [1, 2, 3]) expect(trial(0, 0, 1, seed)).toBeGreaterThan(PVP.missileDamage * 0.75);
  });

  it('a single hard break is still hit, whenever it starts', () => {
    for (const tgo of [0.5, 1.5, 4]) for (const side of [1, -1]) expect(trial(2, tgo, side, 1)).toBeGreaterThan(0);
  });

  it('a hard flip the other way 1 to 1.5 s before impact makes it miss', () => {
    for (const tgo of [1, 1.5]) for (const side of [1, -1]) for (const seed of [1, 2]) expect(trial(2, tgo, side, seed, true)).toBe(0);
  });

  it('the same flip too early or too late does not', () => {
    for (const tgo of [0.5, 4]) for (const side of [1, -1]) expect(trial(2, tgo, side, 1, true)).toBeGreaterThan(0);
  });
});
