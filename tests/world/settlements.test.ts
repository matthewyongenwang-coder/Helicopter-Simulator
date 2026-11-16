import { describe, expect, it } from 'vitest';
import { Biome, PROPS, ROADS, SETTLEMENTS } from '../../src/data/world';
import { ColliderSet } from '../../src/game/colliders';
import { WorldEnvironment } from '../../src/game/worldEnv';
import { SurfaceKind, type SphereContact, type SurfaceHit } from '../../src/sim/types';
import { buildForestCell, TREE_STRIDE } from '../../src/world/forest';
import { seedFromString } from '../../src/world/rng';
import { densityAt, SettlementKind, type Settlement } from '../../src/world/settlements';
import { BOX_STRIDE, buildStructureCell, COLLIDER_STRIDE, helipadsNear, HOUSE_STRIDE, type StructureCell } from '../../src/world/structures';
import { newSurface } from '../../src/world/terrain';
import { World } from '../../src/world/world';

const SEEDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
const C = PROPS.structureCell;

/** Where the game starts: the nearest city heliport to the origin. */
function spawnOf(world: World) {
  const pads = helipadsNear(world, 0, 0, 30000);
  return pads.find((p) => p.kind === 'ground' && p.rank === 3) ?? pads.find((p) => p.kind === 'ground')!;
}

function cityNear(world: World, x: number, z: number): Settlement {
  return world.settlements
    .within(x, z, 30000)
    .filter((s) => s.kind === SettlementKind.City)
    .sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
}

function cellsAround(world: World, x: number, z: number, range: number): StructureCell[] {
  const out: StructureCell[] = [];
  for (let j = Math.floor((z - range) / C); j <= Math.floor((z + range) / C); j++) {
    for (let i = Math.floor((x - range) / C); i <= Math.floor((x + range) / C); i++) out.push(buildStructureCell(world, i, j));
  }
  return out;
}

describe('a typical area', () => {
  it('the 25 km around the start has water, forest, towns, a dense city, roads and at least one bridge', () => {
    for (const name of SEEDS) {
      const world = new World(seedFromString(name));
      const pad = spawnOf(world);
      expect(pad, `${name}: a heliport to start from`).toBeTruthy();
      const half = 12500;

      // Water and forest.
      const surf = newSurface();
      let water = 0, forest = 0, n = 0;
      for (let z = pad.z - half; z < pad.z + half; z += 300) {
        for (let x = pad.x - half; x < pad.x + half; x += 300) {
          const b = world.surfaceAt(x, z, surf).biome;
          n++;
          if (b === Biome.Ocean || b === Biome.Shallows) water++;
          if (b === Biome.Forest) forest++;
        }
      }
      expect(water / n, `${name}: water`).toBeGreaterThan(0.05);
      expect(forest / n, `${name}: forest`).toBeGreaterThan(0.05);

      // Settlements of several sizes.
      const inArea = world.settlements.within(pad.x, pad.z, half * 1.42).filter((s) => Math.abs(s.x - pad.x) < half && Math.abs(s.z - pad.z) < half);
      const cities = inArea.filter((s) => s.kind === SettlementKind.City);
      const towns = inArea.filter((s) => s.kind === SettlementKind.Town);
      expect(cities.length, `${name}: city`).toBeGreaterThanOrEqual(1);
      expect(towns.length, `${name}: towns`).toBeGreaterThanOrEqual(1);
      expect(inArea.length, `${name}: settlements`).toBeGreaterThanOrEqual(4);

      // A dense downtown with skyscrapers.
      let towers = 0, tallest = 0;
      for (const cell of cellsAround(world, cities[0].x, cities[0].z, 600)) {
        for (let k = 0; k < cell.boxes.length; k += BOX_STRIDE) {
          if (cell.boxes[k + 4] > 60) towers++;
          tallest = Math.max(tallest, cell.boxes[k + 4]);
        }
      }
      expect(towers, `${name}: towers over 60 m`).toBeGreaterThan(40);
      expect(tallest, `${name}: tallest building`).toBeGreaterThan(120);

      // Roads and bridges.
      let km = 0, bridges = 0;
      for (const r of world.roads.inRect(pad.x - half, pad.z - half, pad.x + half, pad.z + half)) {
        km += r.points[r.points.length - 1].s / 1000;
        bridges += r.bridges.filter(([a]) => Math.abs(r.points[a].x - pad.x) < half && Math.abs(r.points[a].z - pad.z) < half).length;
      }
      expect(km, `${name}: road length`).toBeGreaterThan(10);
      expect(bridges, `${name}: bridges`).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('settlements', () => {
  const world = new World(seedFromString('alpha'));
  const city = cityNear(world, 0, 0);

  it('are deterministic and differ between seeds', () => {
    const again = new World(seedFromString('alpha'));
    const a = world.settlements.within(0, 0, 40000), b = again.settlements.within(0, 0, 40000);
    expect(a.map((s) => [s.x, s.z, s.kind, s.name])).toEqual(b.map((s) => [s.x, s.z, s.kind, s.name]));
    const other = new World(seedFromString('bravo')).settlements.within(0, 0, 40000);
    expect(other.map((s) => Math.round(s.x))).not.toEqual(a.map((s) => Math.round(s.x)));
    const c1 = buildStructureCell(world, Math.floor(city.x / C), Math.floor(city.z / C));
    const c2 = buildStructureCell(again, Math.floor(city.x / C), Math.floor(city.z / C));
    expect(Array.from(c1.boxes)).toEqual(Array.from(c2.boxes));
    expect(Array.from(c1.ribbonPos)).toEqual(Array.from(c2.ribbonPos));
    expect(Array.from(c1.colliders)).toEqual(Array.from(c2.colliders));
  });

  it('come in every size, with cities the rarest', () => {
    const counts = [0, 0, 0, 0];
    for (const s of world.settlements.within(0, 0, 90000)) counts[s.kind]++;
    for (const c of counts) expect(c).toBeGreaterThan(3);
    expect(counts[SettlementKind.City]).toBeLessThan(counts[SettlementKind.Town] + counts[SettlementKind.Village] + counts[SettlementKind.Hamlet]);
  });

  it('sit on dry, level ground that has been flattened for them', () => {
    for (const s of world.settlements.within(0, 0, 40000)) {
      expect(world.height(s.x, s.z)).toBeGreaterThan(2);
      // Inside the core the ground is close to level.
      for (let a = 0; a < 8; a++) {
        const r = s.radius * 0.4;
        const h = world.height(s.x + Math.cos(a) * r, s.z + Math.sin(a) * r);
        if (h > 0.5) expect(Math.abs(h - s.y)).toBeLessThan(6);
      }
    }
  });

  it('density fades smoothly from the centre outward', () => {
    let prev = world.density(city.x, city.z);
    expect(prev).toBeGreaterThan(0.95);
    for (let d = 10; d <= city.radius * 1.1; d += 10) {
      const v = world.density(city.x + d * 0.6, city.z + d * 0.8);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      expect(prev - v).toBeLessThan(0.03); // no cliff anywhere
      prev = v;
    }
    expect(prev).toBe(0);
  });

  it('buildings step down from skyscrapers downtown to houses at the edge', () => {
    const rings = [
      { max: 0.25, sum: 0, n: 0 },
      { max: 0.55, sum: 0, n: 0 },
      { max: 1.0, sum: 0, n: 0 },
    ];
    let houses = 0, housesOuter = 0;
    for (const cell of cellsAround(world, city.x, city.z, city.radius)) {
      for (let k = 0; k < cell.boxes.length; k += BOX_STRIDE) {
        const d = Math.hypot(cell.x0 + cell.boxes[k] - city.x, cell.z0 + cell.boxes[k + 2] - city.z) / city.radius;
        const ring = rings.find((r) => d <= r.max);
        if (ring) {
          ring.sum += cell.boxes[k + 4];
          ring.n++;
        }
      }
      for (let k = 0; k < cell.houses.length; k += HOUSE_STRIDE) {
        const d = Math.hypot(cell.x0 + cell.houses[k] - city.x, cell.z0 + cell.houses[k + 2] - city.z) / city.radius;
        houses++;
        if (d > 0.5) housesOuter++;
        expect(cell.houses[k + 4]).toBeLessThan(8);
      }
    }
    const mean = rings.map((r) => r.sum / r.n);
    expect(rings[0].n).toBeGreaterThan(50);
    expect(mean[0]).toBeGreaterThan(55);
    expect(mean[0]).toBeGreaterThan(mean[1] * 1.8);
    expect(mean[1]).toBeGreaterThan(mean[2]);
    expect(houses).toBeGreaterThan(500);
    expect(housesOuter / houses).toBeGreaterThan(0.9);
  });

  it('villages and hamlets are houses only', () => {
    const small = world.settlements.within(0, 0, 40000).filter((s) => s.kind <= SettlementKind.Village);
    expect(small.length).toBeGreaterThan(3);
    for (const s of small.slice(0, 6)) {
      let boxes = 0, houses = 0;
      for (const cell of cellsAround(world, s.x, s.z, s.radius)) {
        for (let k = 0; k < cell.boxes.length; k += BOX_STRIDE) {
          if (Math.hypot(cell.x0 + cell.boxes[k] - s.x, cell.z0 + cell.boxes[k + 2] - s.z) < s.radius) boxes++;
        }
        for (let k = 0; k < cell.houses.length; k += HOUSE_STRIDE) {
          if (Math.hypot(cell.x0 + cell.houses[k] - s.x, cell.z0 + cell.houses[k + 2] - s.z) < s.radius) houses++;
        }
      }
      expect(boxes).toBe(0);
      expect(houses).toBeGreaterThan(3);
      expect(densityAt(s, 0)).toBeLessThan(SETTLEMENTS.midriseDensity);
    }
  });

  it('city streets form a grid with intersections and street lights', () => {
    const cell = buildStructureCell(world, Math.floor(city.x / C), Math.floor(city.z / C));
    expect(cell.ribbonIndex.length / 3).toBeGreaterThan(400);
    expect(cell.lights.length / 3).toBeGreaterThan(100);
    // Street surfaces lie on the ground, lifted a little to avoid z-fighting.
    for (let v = 0; v < cell.ribbonPos.length; v += 3 * 37) {
      const x = cell.x0 + cell.ribbonPos[v], z = cell.z0 + cell.ribbonPos[v + 2];
      const lift = cell.ribbonPos[v + 1] - world.height(x, z);
      if (cell.ribbonUv[v + 2] === 0) {
        expect(lift).toBeGreaterThan(0.1);
        expect(lift).toBeLessThan(0.4);
      }
    }
  });
});

describe('roads and bridges', () => {
  const world = new World(seedFromString('echo'));
  const pad = spawnOf(world);
  const roads = world.roads.inRect(pad.x - 15000, pad.z - 15000, pad.x + 15000, pad.z + 15000);

  it('connect settlements end to end', () => {
    expect(roads.length).toBeGreaterThan(3);
    for (const r of roads) {
      const first = r.points[0], last = r.points[r.points.length - 1];
      expect(Math.hypot(first.x - r.a.x, first.z - r.a.z)).toBeLessThan(1);
      expect(Math.hypot(last.x - r.b.x, last.z - r.b.z)).toBeLessThan(1);
    }
    expect(roads.some((r) => r.kind === 1), 'a highway').toBe(true);
    expect(roads.some((r) => r.kind === 0), 'a rural road').toBe(true);
  });

  it('wander rather than run dead straight, and follow the terrain', () => {
    for (const r of roads) {
      const first = r.points[0], last = r.points[r.points.length - 1];
      const straight = Math.hypot(last.x - first.x, last.z - first.z);
      expect(last.s).toBeGreaterThan(straight * 1.002);
      expect(last.s).toBeLessThan(straight * 1.6);
      for (let i = 1; i < r.points.length; i++) {
        const p = r.points[i], q = r.points[i - 1];
        // Gentle grade, and on land the ground has been cut or filled to meet the road.
        expect(Math.abs(p.y - q.y) / (p.s - q.s)).toBeLessThan(ROADS.maxGrade + 0.005);
        if (!p.bridge && !q.bridge) expect(Math.abs(world.height(p.x, p.z) - p.y)).toBeLessThan(0.25);
      }
    }
  });

  it('bridges carry the road over water with clearance, and leave the water underneath', () => {
    let bridges = 0, withTowers = 0;
    for (const r of roads) {
      for (const [a, b] of r.bridges) {
        bridges++;
        let wet = 0;
        for (let i = a; i <= b; i++) {
          const p = r.points[i];
          const g = world.height(p.x, p.z);
          if (g < 0) {
            wet++;
            expect(p.y, 'deck clearance over water').toBeGreaterThanOrEqual(ROADS.minDeck);
          }
          expect(p.y).toBeGreaterThan(g); // the deck never dips into the ground
        }
        expect(wet, 'a bridge spans water').toBeGreaterThan(0);
        expect(r.points[b].s - r.points[a].s).toBeLessThan(ROADS.maxBridge + 150);
        if (r.points[b].s - r.points[a].s > ROADS.towerSpan) withTowers++;
      }
    }
    expect(bridges).toBeGreaterThan(3);
    expect(withTowers).toBeGreaterThan(0);
  });

  it('a bridge deck is solid: it has piers, a landable surface and blocks flight through it', () => {
    // Find the longest bridge and load the structure cells around its middle.
    let best: { x: number; z: number; y: number } | null = null, span = 0;
    for (const r of roads) {
      for (const [a, b] of r.bridges) {
        const len = r.points[b].s - r.points[a].s;
        if (len > span) {
          span = len;
          const m = r.points[Math.floor((a + b) / 2)];
          best = { x: (m.x + r.points[Math.floor((a + b) / 2) + 1].x) / 2, z: (m.z + r.points[Math.floor((a + b) / 2) + 1].z) / 2, y: m.y };
        }
      }
    }
    expect(best).toBeTruthy();
    const env = new WorldEnvironment(world);
    let slabs = 0;
    for (const cell of cellsAround(world, best!.x, best!.z, 300)) {
      env.colliders.add(`${cell.cx},${cell.cz}`, cell.x0, cell.z0, cell.colliders);
      slabs += cell.slabs.length;
    }
    expect(slabs).toBeGreaterThan(0);
    const hit: SurfaceHit = { height: 0, nx: 0, ny: 1, nz: 0, kind: SurfaceKind.Terrain };
    // From above: the deck. From below: the water.
    env.surface(best!.x, best!.z, best!.y + 5, hit);
    expect(hit.kind).toBe(SurfaceKind.Structure);
    expect(Math.abs(hit.height - best!.y)).toBeLessThan(1.5);
    env.surface(best!.x, best!.z, 1, hit);
    expect(hit.kind).toBe(SurfaceKind.Water);
    const c: SphereContact = { depth: 0, nx: 0, ny: 0, nz: 0 };
    expect(env.collide(best!.x, best!.y - 0.4, best!.z, 0.5, c)).toBe(true);
    expect(env.collide(best!.x, best!.y + 30, best!.z, 0.5, c)).toBe(false);
  });
});

describe('helipads and colliders', () => {
  const world = new World(seedFromString('alpha'));
  const city = cityNear(world, 0, 0);

  it('every settlement has a ground helipad on dry land, and cities have rooftop pads too', () => {
    for (const s of world.settlements.within(0, 0, 30000)) {
      const pads = helipadsNear(world, s.x, s.z, 1).filter((p) => p.settlement === s.name);
      const ground = pads.filter((p) => p.kind === 'ground');
      expect(ground.length, s.name).toBe(1);
      expect(ground[0].y).toBeGreaterThan(2);
      expect(Math.hypot(ground[0].x - s.x, ground[0].z - s.z)).toBeLessThan(s.radius * 0.5 + 60);
      if (s.kind === SettlementKind.City) {
        const roof = pads.filter((p) => p.kind === 'roof');
        expect(roof.length).toBeGreaterThan(2);
        for (const p of roof) expect(p.y - world.height(p.x, p.z)).toBeGreaterThan(15);
      }
    }
  });

  it('the listed helipads are really there: landable, and reported as helipad surface', () => {
    const env = new WorldEnvironment(world);
    for (const cell of cellsAround(world, city.x, city.z, city.radius * 0.6)) env.colliders.add(`${cell.cx},${cell.cz}`, cell.x0, cell.z0, cell.colliders);
    const pads = helipadsNear(world, city.x, city.z, 1).filter((p) => Math.hypot(p.x - city.x, p.z - city.z) < city.radius * 0.5);
    expect(pads.length).toBeGreaterThan(3);
    const hit: SurfaceHit = { height: 0, nx: 0, ny: 1, nz: 0, kind: SurfaceKind.Terrain };
    for (const p of pads) {
      env.surface(p.x, p.z, p.y + 3, hit);
      expect(hit.kind, p.name).toBe(SurfaceKind.Helipad);
      expect(Math.abs(hit.height - p.y), p.name).toBeLessThan(0.3);
    }
  });

  it('buildings are solid from the side and landable on top', () => {
    const set = new ColliderSet();
    const cell = buildStructureCell(world, Math.floor(city.x / C), Math.floor(city.z / C));
    set.add('c', cell.x0, cell.z0, cell.colliders);
    expect(set.count).toBe(cell.colliders.length / COLLIDER_STRIDE);
    // Take the tallest building in the cell.
    let o = 0;
    for (let k = 0; k < cell.colliders.length; k += COLLIDER_STRIDE) if (cell.colliders[k + 4] > cell.colliders[o + 4]) o = k;
    const d = cell.colliders;
    const x = cell.x0 + d[o], z = cell.z0 + d[o + 2], top = d[o + 1] + d[o + 4];
    expect(d[o + 4] * 2).toBeGreaterThan(60);
    const c: SphereContact = { depth: 0, nx: 0, ny: 0, nz: 0 };
    // Inside the wall at mid-height: a contact with a horizontal normal.
    const px = x + d[o + 6] * (d[o + 3] - 0.3), pz = z + d[o + 7] * (d[o + 3] - 0.3);
    expect(set.sphere(px, d[o + 1], pz, 1, c)).toBe(true);
    expect(Math.abs(c.ny)).toBeLessThan(0.01);
    expect(c.nx * d[o + 6] + c.nz * d[o + 7]).toBeGreaterThan(0.99); // pushes back out through that wall
    expect(c.depth).toBeGreaterThan(0.5);
    // Just above the roof: nothing to hit, and the roof is the surface below.
    expect(set.sphere(x, top + 3, z, 1, c)).toBe(false);
    expect(set.topAt(x, z, top + 3)).toBeCloseTo(top, 5);
    // Well below the roof, the roof is not "under" the probe.
    expect(set.topAt(x, z, top - 10)).toBe(-Infinity);
    set.remove('c');
    expect(set.count).toBe(0);
    expect(set.sphere(px, d[o + 1], pz, 1, c)).toBe(false);
  });
});

describe('forests and props', () => {
  const world = new World(seedFromString('alpha'));

  it('forest cells put trees on dry land, off the roads and out of downtown', () => {
    const surf = newSurface();
    let total = 0, cells = 0;
    for (let j = -30; j < 30 && cells < 40; j += 3) {
      for (let i = -30; i < 30 && cells < 40; i += 3) {
        const cell = buildForestCell(world, i, j);
        const n = cell.trees.length / TREE_STRIDE;
        if (n === 0) continue;
        cells++;
        total += n;
        for (let k = 0; k < cell.trees.length; k += TREE_STRIDE * 7) {
          const x = cell.x0 + cell.trees[k], z = cell.z0 + cell.trees[k + 2];
          expect(world.height(x, z)).toBeGreaterThan(0.5);
          expect(world.density(x, z)).toBeLessThan(0.2);
          const road = world.roadAt(x, z);
          if (road && !road.bridge) expect(road.d).toBeGreaterThan(road.road!.halfWidth);
          expect(world.surfaceAt(x, z, surf).trees).toBeGreaterThan(0);
          expect(cell.trees[k + 3]).toBeGreaterThan(0.5);
        }
      }
    }
    expect(cells).toBeGreaterThan(10);
    expect(total / cells).toBeGreaterThan(20);
  });

  it('power lines, wind turbines and boats all appear in a 30 km survey', () => {
    let pylons = 0, wires = 0, turbines = 0, boats = 0, farTrees = 0, lights = 0;
    for (let j = -15; j < 15; j++) {
      for (let i = -15; i < 15; i++) {
        const c = buildStructureCell(world, i, j);
        pylons += c.pylons.length / 5;
        wires += c.wires.length / 6;
        turbines += c.turbines.length / 5;
        boats += c.boats.length / 4;
        farTrees += c.farTrees.length / TREE_STRIDE;
        lights += c.lights.length / 3;
        // Boats float; turbines and pylons stand on land.
        for (let k = 0; k < c.boats.length; k += 4) expect(world.height(c.x0 + c.boats[k], c.z0 + c.boats[k + 1])).toBeLessThan(-2);
        for (let k = 0; k < c.turbines.length; k += 5) expect(world.height(c.x0 + c.turbines[k], c.z0 + c.turbines[k + 2])).toBeGreaterThan(15);
        for (let k = 0; k < c.pylons.length; k += 5) expect(world.height(c.x0 + c.pylons[k], c.z0 + c.pylons[k + 2])).toBeGreaterThan(1);
      }
    }
    expect(pylons).toBeGreaterThan(20);
    expect(wires).toBeGreaterThan(pylons * 8);
    expect(turbines).toBeGreaterThan(8);
    expect(boats).toBeGreaterThan(10);
    expect(farTrees).toBeGreaterThan(5000);
    expect(lights).toBeGreaterThan(500);
  });

  it('structures generate thousands of kilometres out as well', () => {
    const far = 3_000_000;
    const s = world.settlements.within(far, far, 20000);
    expect(s.length).toBeGreaterThan(5);
    const cell = buildStructureCell(world, Math.floor(s[0].x / C), Math.floor(s[0].z / C));
    expect(cell.houses.length + cell.boxes.length).toBeGreaterThan(0);
    for (const v of cell.colliders) expect(Number.isFinite(v)).toBe(true);
  });
});
