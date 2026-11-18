import { describe, expect, it } from 'vitest';
import { SUPPLY } from '../../src/data/weapons';
import { compoundsNear } from '../../src/world/compounds';
import { suppliesNear } from '../../src/world/supply';
import { World } from '../../src/world/world';

describe('supply points', () => {
  const world = new World(424242);
  const sites = suppliesNear(world, 0, 0, 25000);

  it('are scattered across the map, so one is never far away', () => {
    expect(sites.length).toBeGreaterThan(12);
    // From anywhere near the middle of the map, the nearest is a short flight.
    for (const [x, z] of [[0, 0], [8000, -6000], [-12000, 4000], [3000, 15000]]) {
      const d = Math.min(...sites.map((s) => Math.hypot(s.x - x, s.z - z)));
      expect(d).toBeLessThan(9000);
    }
  });

  it('are a pure function of the seed', () => {
    const again = suppliesNear(new World(424242), 0, 0, 25000);
    expect(again.map((s) => `${s.id}@${s.x.toFixed(2)},${s.z.toFixed(2)}:${s.name}`)).toEqual(sites.map((s) => `${s.id}@${s.x.toFixed(2)},${s.z.toFixed(2)}:${s.name}`));
  });

  it('stand on level, dry, open ground well away from every compound', () => {
    for (const s of sites) {
      expect(world.height(s.x, s.z)).toBeGreaterThan(2);
      expect(world.density(s.x, s.z)).toBeLessThan(0.01);
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const h = world.height(s.x + Math.cos(a) * SUPPLY.radius * 0.9, s.z + Math.sin(a) * SUPPLY.radius * 0.9);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
      expect(hi - lo).toBeLessThan(SUPPLY.maxRelief + 1);
      expect(compoundsNear(world, s.x, s.z, SUPPLY.compoundClear)).toHaveLength(0);
      // The field is cleared of trees.
      expect(world.surfaceAt(s.x + 10, s.z).trees).toBeLessThan(0.01);
    }
  });
});
