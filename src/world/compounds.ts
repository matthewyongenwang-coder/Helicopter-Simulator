import { COMPOUNDS } from '../data/weapons';
import { hash2, rng } from './rng';
import type { World } from './world';

/**
 * Hostile compounds: walled outposts with buildings, fuel, ammunition and the
 * guns and missiles that defend them. Like the rest of the world they are a
 * pure function of the seed, so the same seed always holds the same compounds.
 */

export const enum PartKind {
  Command = 0,
  Barracks = 1,
  Depot = 2,
  Tanks = 3,
  Sam = 4,
  Radar = 5,
  Aaa = 6,
  Mg = 7,
  Tower = 8,
  Truck = 9,
}

export type EnemyWeapon = 'mg' | 'aaa' | 'sam';

export interface PartType {
  name: string;
  /** Half extents of the hit box (x across, y up, z along). */
  hx: number;
  hy: number;
  hz: number;
  hp: number;
  weapon?: EnemyWeapon;
  /** Height of the gun or launcher above the base. */
  mount?: number;
  /** A blast when it goes up: hit points and radius. */
  secondary?: [number, number];
}

export const PART_TYPES: Record<PartKind, PartType> = {
  [PartKind.Command]: { name: 'Command post', hx: 8, hy: 3.4, hz: 5.5, hp: 320 },
  [PartKind.Barracks]: { name: 'Barracks', hx: 9, hy: 2.2, hz: 3.6, hp: 200 },
  [PartKind.Depot]: { name: 'Ammunition', hx: 4.5, hy: 1.7, hz: 4.5, hp: 140, secondary: [280, 30] },
  [PartKind.Tanks]: { name: 'Fuel', hx: 5, hy: 2.3, hz: 2.4, hp: 90, secondary: [180, 22] },
  [PartKind.Sam]: { name: 'SAM launcher', hx: 3.4, hy: 1.6, hz: 1.6, hp: 170, weapon: 'sam', mount: 2.4, secondary: [80, 12] },
  [PartKind.Radar]: { name: 'Radar', hx: 1.8, hy: 3.6, hz: 1.8, hp: 80 },
  [PartKind.Aaa]: { name: 'Anti-aircraft gun', hx: 2.3, hy: 1.1, hz: 2.3, hp: 120, weapon: 'aaa', mount: 1.6 },
  [PartKind.Mg]: { name: 'Machine gun nest', hx: 2.1, hy: 0.75, hz: 2.1, hp: 70, weapon: 'mg', mount: 1.25 },
  [PartKind.Tower]: { name: 'Guard tower', hx: 1.9, hy: 4.9, hz: 1.9, hp: 110, weapon: 'mg', mount: 8.7 },
  [PartKind.Truck]: { name: 'Truck', hx: 1.3, hy: 1.4, hz: 3.6, hp: 60, secondary: [60, 10] },
};

export interface CompoundPart {
  kind: PartKind;
  /** World position of the base centre, and its yaw (rotation about +Y, radians). */
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface WallSegment {
  x: number;
  y: number;
  z: number;
  yaw: number;
  len: number;
}

export interface CompoundSite {
  /** Stable key: the generation cell. */
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Half the side of the walled square. */
  half: number;
  parts: CompoundPart[];
  walls: WallSegment[];
  /** A red flag on a pole marks the compound from the air. */
  flag: { x: number; y: number; z: number };
}

const ALPHABET = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 'Victor', 'Whiskey', 'X-ray', 'Yankee', 'Zulu'];

/** Rotate a local offset by `yaw` (the same convention as Object3D.rotation.y). */
export function localToWorld(cx: number, cz: number, yaw: number, lx: number, lz: number): [number, number] {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [cx + lx * c + lz * s, cz - lx * s + lz * c];
}

/** Ground under a rectangle: the lowest of its centre and corners, so nothing floats. */
function footing(world: World, x: number, z: number, yaw: number, hx: number, hz: number): number {
  let h = world.height(x, z);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const [px, pz] = localToWorld(x, z, yaw, sx * hx, sz * hz);
    h = Math.min(h, world.height(px, pz));
  }
  return Math.max(0, h);
}

/** Can a compound of this size stand here? Dry, fairly level, away from towns and roads. */
function siteOk(world: World, x: number, z: number, half: number): boolean {
  const h0 = world.height(x, z);
  if (h0 < 4 || h0 > 1400) return false;
  let lo = h0, hi = h0;
  const r = half * 1.25;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const h = world.height(x + Math.cos(a) * r, z + Math.sin(a) * r);
    if (h < 2) return false;
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  if (hi - lo > COMPOUNDS.maxRelief) return false;
  if (world.density(x, z) > 0.002) return false;
  for (const s of world.settlements.within(x, z, COMPOUNDS.settlementClear + 4000)) {
    if (Math.hypot(s.x - x, s.z - z) < COMPOUNDS.settlementClear + s.radius) return false;
  }
  const road = world.roadAt(x, z);
  if (road && road.d < COMPOUNDS.roadClear + half) return false;
  return true;
}

/** The compound in generation cell (i, j), or null if the cell holds none. */
export function compoundInCell(world: World, i: number, j: number): CompoundSite | null {
  const seed = world.seed ^ 0x51c0ffee;
  if (hash2(i, j, seed) / 4294967296 >= COMPOUNDS.chance) return null;
  const rand = rng(hash2(i, j, seed + 7));
  const C = COMPOUNDS.cell;
  const half = 40 + Math.floor(rand() * 4) * 5;
  // A few tries inside the cell for a level, quiet spot.
  let x = 0, z = 0, ok = false;
  for (let t = 0; t < 4 && !ok; t++) {
    x = (i + 0.15 + rand() * 0.7) * C;
    z = (j + 0.15 + rand() * 0.7) * C;
    ok = siteOk(world, x, z, half);
  }
  if (!ok) return null;
  const yaw = rand() * Math.PI * 2;
  const name = `${ALPHABET[Math.floor(rand() * ALPHABET.length)]}-${10 + Math.floor(rand() * 90)}`;
  const parts: CompoundPart[] = [];
  const place = (kind: PartKind, lx: number, lz: number, lyaw: number) => {
    const t = PART_TYPES[kind];
    const [px, pz] = localToWorld(x, z, yaw, lx, lz);
    const pyaw = yaw + lyaw;
    parts.push({ kind, x: px, z: pz, y: footing(world, px, pz, pyaw, t.hx, t.hz), yaw: pyaw });
  };

  // Inside the walls: a 3 × 3 grid of plots, the command post in the middle.
  const g = half * 0.6;
  const jit = () => (rand() - 0.5) * g * 0.22;
  const quarter = () => Math.floor(rand() * 4) * (Math.PI / 2) + (rand() - 0.5) * 0.12;
  place(PartKind.Command, jit() * 0.5, jit() * 0.5, quarter());
  const plots: [number, number][] = [];
  for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) if (a || b) plots.push([a * g, b * g]);
  for (let k = plots.length - 1; k > 0; k--) {
    const m = Math.floor(rand() * (k + 1));
    [plots[k], plots[m]] = [plots[m], plots[k]];
  }
  const fill: PartKind[] = [PartKind.Barracks, PartKind.Depot, PartKind.Tanks];
  if (rand() < 0.85) fill.push(PartKind.Sam, PartKind.Radar);
  if (rand() < 0.65) fill.push(PartKind.Aaa);
  if (rand() < 0.6) fill.push(PartKind.Barracks);
  fill.push(PartKind.Truck);
  if (rand() < 0.5) fill.push(PartKind.Truck);
  for (let k = 0; k < fill.length && k < plots.length; k++) {
    const [px, pz] = plots[k];
    place(fill[k], px + jit(), pz + jit(), quarter());
  }
  // Corners: two guard towers on one diagonal, two gun nests on the other.
  const c = half - 6;
  place(PartKind.Tower, -c, -c, 0);
  place(PartKind.Tower, c, c, 0);
  place(PartKind.Mg, c, -c, 0);
  place(PartKind.Mg, -c, c, 0);
  if (rand() < 0.5) place(PartKind.Mg, 0, half - 9, 0);

  // Perimeter wall in short sections that follow the ground, with a gate on the +z side.
  const walls: WallSegment[] = [];
  const n = Math.max(6, Math.round((half * 2) / 9));
  const len = (half * 2) / n;
  for (let side = 0; side < 4; side++) {
    const sYaw = (side * Math.PI) / 2;
    for (let k = 0; k < n; k++) {
      const along = -half + (k + 0.5) * len;
      if (side === 0 && Math.abs(along) < len) continue; // gate
      // Side 0 runs along +z, then the square turns a quarter at a time.
      const [lx, lz] = localToWorld(0, 0, sYaw, along, half);
      const [wx, wz] = localToWorld(x, z, yaw, lx, lz);
      const wyaw = yaw + sYaw;
      walls.push({ x: wx, z: wz, yaw: wyaw, len, y: footing(world, wx, wz, wyaw, len / 2, 0.8) });
    }
  }
  const [fx, fz] = localToWorld(x, z, yaw, g * 0.55, -g * 0.55);
  return {
    id: `${i}:${j}`,
    name: `Compound ${name}`,
    x, z, y: Math.max(0, world.height(x, z)), yaw, half, parts, walls,
    flag: { x: fx, z: fz, y: Math.max(0, world.height(fx, fz)) },
  };
}

/**
 * Every compound whose centre lies within `range` of a point, optionally
 * leaving out any too close to `clear` (the start). `cache` keeps generated
 * cells between calls, since sites are re-queried as the aircraft moves.
 */
export function compoundsNear(
  world: World,
  x: number,
  z: number,
  range: number,
  cache?: Map<string, CompoundSite | null>,
  clear?: { x: number; z: number; r: number },
): CompoundSite[] {
  const C = COMPOUNDS.cell;
  const out: CompoundSite[] = [];
  for (let j = Math.floor((z - range) / C); j <= Math.floor((z + range) / C); j++) {
    for (let i = Math.floor((x - range) / C); i <= Math.floor((x + range) / C); i++) {
      const key = `${i}:${j}`;
      let site = cache?.get(key);
      if (site === undefined) {
        site = compoundInCell(world, i, j);
        cache?.set(key, site);
      }
      if (!site) continue;
      if (clear && Math.hypot(site.x - clear.x, site.z - clear.z) < clear.r) continue;
      if (Math.hypot(site.x - x, site.z - z) <= range) out.push(site);
    }
  }
  return out;
}
