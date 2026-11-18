import { describe, expect, it } from 'vitest';
import { COMPOUNDS } from '../../src/data/weapons';
import { compoundsNear, PART_TYPES } from '../../src/world/compounds';
import { World } from '../../src/world/world';

describe('enemy compounds', () => {
  const world = new World(424242);
  const sites = compoundsNear(world, 0, 0, 30000);

  it('are scattered across the map', () => {
    // A 60 km square should hold a fair number, but not wall-to-wall.
    expect(sites.length).toBeGreaterThan(8);
    expect(sites.length).toBeLessThan(160);
  });

  it('are a pure function of the seed', () => {
    const again = compoundsNear(new World(424242), 0, 0, 30000);
    expect(again.map((s) => `${s.id}@${s.x.toFixed(2)},${s.z.toFixed(2)}`)).toEqual(sites.map((s) => `${s.id}@${s.x.toFixed(2)},${s.z.toFixed(2)}`));
  });

  it('stand on dry land away from towns, with guns to defend them', () => {
    for (const s of sites.slice(0, 20)) {
      expect(world.height(s.x, s.z)).toBeGreaterThan(2);
      expect(world.density(s.x, s.z)).toBeLessThan(0.01);
      expect(s.parts.some((p) => PART_TYPES[p.kind].weapon === 'mg')).toBe(true);
      expect(s.walls.length).toBeGreaterThan(16);
      for (const p of s.parts) expect(Math.hypot(p.x - s.x, p.z - s.z)).toBeLessThan(s.half * 1.5);
    }
  });

  it('keep clear of the start', () => {
    const clear = { x: sites[0].x, z: sites[0].z, r: COMPOUNDS.homeClear };
    const near = compoundsNear(world, clear.x, clear.z, 10000, undefined, clear);
    for (const s of near) expect(Math.hypot(s.x - clear.x, s.z - clear.z)).toBeGreaterThanOrEqual(clear.r);
  });
});
