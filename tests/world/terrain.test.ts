import { describe, expect, it } from 'vitest';
import { Biome } from '../../src/data/world';
import { buildTerrainMesh, terrainIndices, terrainVertexCount } from '../../src/world/meshgen';
import { randomSeed, seedFromString, seedToString } from '../../src/world/rng';
import { newSurface } from '../../src/world/terrain';
import { World } from '../../src/world/world';

const SEEDS = ['alpha', 'bravo', 'charlie', 'delta'].map(seedFromString);

/** Deterministic scatter of sample points over a square of the given span. */
function points(n: number, span: number, salt = 1): [number, number][] {
  const out: [number, number][] = [];
  let s = 12345 * salt;
  const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296 - 0.5) * span;
  for (let i = 0; i < n; i++) out.push([r(), r()]);
  return out;
}

describe('seed system', () => {
  it('the same seed reproduces the same world, exactly', () => {
    const a = new World(SEEDS[0]), b = new World(SEEDS[0]);
    for (const [x, z] of points(400, 80000)) expect(a.height(x, z)).toBe(b.height(x, z));
    const ma = buildTerrainMesh(a, 2048, -4096, 256, 48), mb = buildTerrainMesh(b, 2048, -4096, 256, 48);
    expect(Array.from(ma.positions)).toEqual(Array.from(mb.positions));
    expect(Array.from(ma.colors)).toEqual(Array.from(mb.colors));
    expect(Array.from(ma.normals)).toEqual(Array.from(mb.normals));
  });

  it('different seeds give different worlds', () => {
    const pts = points(400, 80000);
    for (let i = 1; i < SEEDS.length; i++) {
      const a = new World(SEEDS[0]), b = new World(SEEDS[i]);
      let differ = 0, landA = 0, landBoth = 0;
      for (const [x, z] of pts) {
        const ha = a.height(x, z), hb = b.height(x, z);
        if (Math.abs(ha - hb) > 1) differ++;
        if (ha > 0) {
          landA++;
          if (hb > 0) landBoth++;
        }
      }
      expect(differ / pts.length).toBeGreaterThan(0.9);
      // Land in one world says little about land in the other: roughly the base rate, not 100 %.
      expect(landBoth / landA).toBeLessThan(0.8);
    }
  });

  it('two launches pick different seeds', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) seen.add(randomSeed());
    expect(seen.size).toBeGreaterThan(48);
  });

  it('the on-screen seed text round-trips', () => {
    for (const s of [0, 1, 123456789, 4294967295, ...SEEDS]) {
      const text = seedToString(s);
      expect(text).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{3}$/);
      expect(seedFromString(text)).toBe(s >>> 0);
      expect(seedFromString(text.toLowerCase())).toBe(s >>> 0);
    }
    expect(seedFromString('42')).toBe(42);
  });
});

describe('the world has no edge', () => {
  it('a 20 minute straight flight at top speed stays over generated terrain', () => {
    // 20 min at 85 m/s (165 kt) is 102 km. Fly four headings from the origin.
    const w = new World(SEEDS[1]);
    const dist = 20 * 60 * 85;
    for (const [dx, dz] of [[1, 0], [0, 1], [-0.7071, 0.7071], [0.6, -0.8]]) {
      let min = Infinity, max = -Infinity, water = 0, land = 0, changes = 0, prev = 0;
      for (let d = 0; d <= dist; d += 40) {
        const h = w.height(dx * d, dz * d);
        expect(Number.isFinite(h)).toBe(true);
        min = Math.min(min, h);
        max = Math.max(max, h);
        if (h < 0) water++;
        else land++;
        if (Math.abs(h - prev) > 0.01) changes++;
        prev = h;
      }
      expect(max - min).toBeGreaterThan(150); // real relief all the way, not a flat fallback
      expect(water).toBeGreaterThan(50);
      expect(land).toBeGreaterThan(50);
      // Height keeps changing step to step. The few flat steps are lake and river beds,
      // which are level by construction.
      expect(changes / (dist / 40)).toBeGreaterThan(0.95);
    }
  });

  it('terrain is just as detailed and continuous thousands of kilometres out', () => {
    const w = new World(SEEDS[2]);
    for (const far of [1e6, -3.7e6, 8e6]) {
      const m = buildTerrainMesh(w, far, far * 0.5, 256, 32);
      let min = Infinity, max = -Infinity;
      for (let i = 1; i < 33 * 33 * 3; i += 3) {
        expect(Number.isFinite(m.positions[i])).toBe(true);
        min = Math.min(min, m.positions[i]);
        max = Math.max(max, m.positions[i]);
      }
      // No precision staircase: neighbouring samples a centimetre apart agree to millimetres.
      for (let k = 0; k < 50; k++) {
        const x = far + k * 37.3, z = far * 0.5 - k * 11.1;
        expect(Math.abs(w.height(x + 0.01, z) - w.height(x, z))).toBeLessThan(0.02);
      }
      // Relief varies across a 20 km walk out here too.
      let lo = Infinity, hi = -Infinity;
      for (let d = 0; d < 20000; d += 100) {
        const h = w.height(far + d, far * 0.5);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
      expect(hi - lo).toBeGreaterThan(30);
      expect(max).toBeGreaterThanOrEqual(min);
    }
  });
});

describe('terrain chunks', () => {
  const w = new World(SEEDS[0]);

  it('neighbouring chunks meet exactly along their shared edge', () => {
    const cells = 32, n = cells + 1;
    const a = buildTerrainMesh(w, 0, 0, 256, cells);
    const b = buildTerrainMesh(w, 256, 0, 256, cells);
    for (let j = 0; j < n; j++) {
      const ya = a.positions[(j * n + cells) * 3 + 1];
      const yb = b.positions[(j * n) * 3 + 1];
      expect(ya).toBe(yb);
    }
  });

  it('mesh data is well formed', () => {
    const cells = 48;
    const m = buildTerrainMesh(w, -512, 768, 512, cells);
    const count = terrainVertexCount(cells);
    expect(m.positions.length).toBe(count * 3);
    expect(m.normals.length).toBe(count * 3);
    expect(m.colors.length).toBe(count * 4);
    for (let i = 0; i < count; i++) {
      const nx = m.normals[i * 3] / 127, ny = m.normals[i * 3 + 1] / 127, nz = m.normals[i * 3 + 2] / 127;
      expect(Math.hypot(nx, ny, nz)).toBeGreaterThan(0.97);
      expect(ny).toBeGreaterThan(0);
    }
    const idx = terrainIndices(cells);
    expect(idx.length).toBe((cells * cells * 2 + cells * 4 * 2) * 3);
    expect(Math.max(...idx)).toBe(count - 1);
    expect(m.maxY).toBeGreaterThan(m.minY);
  });

  it('a coarse LOD follows the fine terrain closely', () => {
    // A 2 km node sampled at 32 cells (64 m spacing) against the full-detail height.
    let worst = 0, sum = 0, n = 0;
    for (const [x0, z0] of [[0, 0], [4096, -2048], [-8192, 6144]]) {
      const m = buildTerrainMesh(w, x0, z0, 2048, 32);
      for (let j = 0; j < 33; j++) {
        for (let i = 0; i < 33; i++) {
          const d = Math.abs(m.positions[(j * 33 + i) * 3 + 1] - w.height(x0 + i * 64, z0 + j * 64));
          worst = Math.max(worst, d);
          sum += d;
          n++;
        }
      }
    }
    expect(sum / n).toBeLessThan(2.5);
    expect(worst).toBeLessThan(14);
  });
});

describe('biomes', () => {
  it('a typical 40 km area has sea, beaches, plains, forest, hills, mountains and farmland', () => {
    for (const seed of SEEDS) {
      const w = new World(seed);
      const counts = new Array(10).fill(0);
      const surf = newSurface();
      const pts = points(6000, 40000, seed);
      for (const [x, z] of pts) counts[w.surfaceAt(x, z, surf).biome]++;
      const frac = (b: Biome) => counts[b] / pts.length;
      const water = frac(Biome.Ocean) + frac(Biome.Shallows);
      expect(water, 'water').toBeGreaterThan(0.08);
      expect(water, 'water').toBeLessThan(0.8);
      expect(frac(Biome.Beach), 'beach').toBeGreaterThan(0.003);
      expect(frac(Biome.Plains) + frac(Biome.Hills), 'grassland').toBeGreaterThan(0.05);
      expect(frac(Biome.Forest), 'forest').toBeGreaterThan(0.04);
      expect(frac(Biome.Farmland), 'farmland').toBeGreaterThan(0.004);
      expect(frac(Biome.Rock) + frac(Biome.Snow), 'mountain').toBeGreaterThan(0.002);
    }
  });

  it('rivers and lakes exist inland', () => {
    const w = new World(SEEDS[0]);
    const s = { h: 0, cont: 0, mountain: 0, river: 0, valley: 0, lake: 0 };
    let river = 0, lake = 0, n = 0;
    for (const [x, z] of points(20000, 60000, 7)) {
      w.sample(x, z, 0, s);
      if (s.cont > 0.08) {
        n++;
        if (s.river > 0.5 && s.h < 0) river++;
        if (s.lake > 0.6 && s.h < 0) lake++;
      }
    }
    expect(river / n).toBeGreaterThan(0.004);
    expect(lake / n).toBeGreaterThan(0.004);
  });

  it('snow only appears high up and sand only near the waterline', () => {
    const w = new World(SEEDS[3]);
    const surf = newSurface();
    for (const [x, z] of points(8000, 60000, 3)) {
      const b = w.surfaceAt(x, z, surf).biome;
      const h = w.height(x, z);
      if (b === Biome.Snow) expect(h).toBeGreaterThan(300);
      if (b === Biome.Beach) expect(h).toBeLessThan(6);
      if (b === Biome.Ocean || b === Biome.Shallows) expect(h).toBeLessThan(0);
    }
  });
});
