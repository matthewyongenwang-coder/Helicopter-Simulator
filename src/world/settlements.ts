import { SETTLEMENTS as S } from '../data/world';
import { hash2, rand2, rng } from './rng';
import { newSample, smoothstep, type Terrain } from './terrain';

export const enum SettlementKind {
  Hamlet = 0,
  Village = 1,
  Town = 2,
  City = 3,
}

export const KIND_NAMES = ['Hamlet', 'Village', 'Town', 'City'];

export interface Settlement {
  id: number;
  ci: number;
  cj: number;
  x: number;
  z: number;
  /** Level the built-up ground is flattened to. */
  y: number;
  radius: number;
  kind: SettlementKind;
  /** Street grid orientation: the local u axis is (cos, sin) in world (x, z). */
  cos: number;
  sin: number;
  name: string;
  seed: number;
}

/** Peak build density by kind. Only cities reach tower density. */
const PEAK = [0.24, 0.36, 0.66, 1.0];

const NAME_A = ['Ash', 'Bel', 'Car', 'Dun', 'El', 'Fen', 'Gal', 'Har', 'Ist', 'Kel', 'Lor', 'Mar', 'Nor', 'Or', 'Pen', 'Quin', 'Ros', 'Sel', 'Tor', 'Ul', 'Val', 'Wes', 'Yar', 'Zan'];
const NAME_B = ['a', 'e', 'i', 'o', 'an', 'en', 'in', 'or', 'ar', 'el', 'is', 'um'];
const NAME_C = ['ford', 'ton', 'by', 'wick', 'haven', 'mouth', 'field', 'stead', 'port', 'dale', 'bridge', 'holm', 'mere', 'crest', 'gate', 'vale'];

function makeName(seed: number): string {
  const r = rng(seed);
  const pick = (a: string[]) => a[Math.floor(r() * a.length)];
  let n = pick(NAME_A);
  if (r() < 0.55) n += pick(NAME_B);
  n += pick(NAME_C);
  return n;
}

const cellKey = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

/**
 * Settlement sites. The plane is cut into cells; each cell deterministically
 * holds at most one settlement, and every 3×3 block of cells holds one city
 * wherever there is flat enough land for it. Lazy and cached, so there is no edge.
 */
export class Settlements {
  private cells = new Map<number, Settlement | null>();
  private cityCell = new Map<number, number>();
  private townCells = new Set<number>();
  private nearCache = new Map<number, Settlement[]>();
  private scratch = newSample();
  /** Settlement that produced the last non-zero density() result. */
  last: Settlement | null = null;

  constructor(private terrain: Terrain, private seed: number) {}

  /** Try to find a buildable site of the given kind inside a cell. */
  private findSite(ci: number, cj: number, kind: SettlementKind): Settlement | null {
    const C = S.cellSize;
    const h0 = hash2(ci, cj, this.seed ^ 0x5e77);
    const [r0, r1] = S.radius[kind];
    const radius = r0 + (r1 - r0) * ((h0 & 1023) / 1023);
    const t = this.terrain, s = this.scratch;
    for (let k = 0; k < 8; k++) {
      const x = (ci + 0.5 + (rand2(ci * 8 + k, cj, this.seed ^ 0x11) - 0.5) * 0.6) * C;
      const z = (cj + 0.5 + (rand2(ci, cj * 8 + k, this.seed ^ 0x22) - 0.5) * 0.6) * C;
      const h = t.sample(x, z, 0, s);
      if (h < S.minElevation || h > S.maxElevation || s.mountain > S.maxMountain) continue;
      let ok = true;
      // Inner ring must be dry and nearly level; the outer ring may touch water (a waterfront).
      for (let a = 0; a < 8 && ok; a++) {
        const ang = (a / 8) * Math.PI * 2;
        const hi = t.height(x + Math.cos(ang) * radius * 0.5, z + Math.sin(ang) * radius * 0.5);
        if (hi < 1.5 || Math.abs(hi - h) > S.maxRelief * radius * 0.5 + 3) ok = false;
        if (ok && (a & 1) === 0) {
          const ho = t.height(x + Math.cos(ang) * radius * 0.95, z + Math.sin(ang) * radius * 0.95);
          if (ho > 0 && Math.abs(ho - h) > S.maxRelief * radius + 5) ok = false;
        }
      }
      if (!ok) continue;
      const ang = rand2(ci, cj, this.seed ^ 0x33) * Math.PI;
      return {
        id: h0,
        ci, cj, x, z,
        y: Math.max(3, h),
        radius,
        kind,
        cos: Math.cos(ang),
        sin: Math.sin(ang),
        name: makeName(h0),
        seed: h0,
      };
    }
    return null;
  }

  /** Which cell of a city block hosts the city (−1 if nowhere is suitable). */
  private cityOf(mi: number, mj: number): number {
    const key = cellKey(mi, mj);
    const hit = this.cityCell.get(key);
    if (hit !== undefined) return hit;
    const n = S.cityEvery;
    const start = hash2(mi, mj, this.seed ^ 0xc17) % (n * n);
    let result = -1;
    for (let k = 0; k < n * n; k++) {
      const idx = (start + k * 4) % (n * n); // 4 is coprime with 9: visits every cell
      const ci = mi * n + (idx % n), cj = mj * n + Math.floor(idx / n);
      const site = this.findSite(ci, cj, SettlementKind.City);
      if (site) {
        this.cells.set(cellKey(ci, cj), site);
        result = cellKey(ci, cj);
        // The next two cells in the same order are earmarked for towns, so every
        // city has market towns within reach rather than only by luck.
        for (let t = 1; t <= S.townsPerCity; t++) {
          const ti = (start + (k + t) * 4) % (n * n);
          this.townCells.add(cellKey(mi * n + (ti % n), mj * n + Math.floor(ti / n)));
        }
        break;
      }
    }
    this.cityCell.set(key, result);
    return result;
  }

  /** The settlement in a cell, if any. */
  at(ci: number, cj: number): Settlement | null {
    const key = cellKey(ci, cj);
    const hit = this.cells.get(key);
    if (hit !== undefined) return hit;
    const n = S.cityEvery;
    if (this.cityOf(Math.floor(ci / n), Math.floor(cj / n)) === key) return this.cells.get(key)!;
    const r = rand2(ci, cj, this.seed ^ 0x77);
    let site: Settlement | null = null;
    if (this.townCells.has(key)) site = this.findSite(ci, cj, SettlementKind.Town);
    if (site) {
      // An earmarked town cell with a usable site.
    } else if (r < S.townChance) site = this.findSite(ci, cj, SettlementKind.Town);
    else if (r < S.townChance + S.villageChance) site = this.findSite(ci, cj, SettlementKind.Village);
    else if (r < S.townChance + S.villageChance + S.hamletChance) site = this.findSite(ci, cj, SettlementKind.Hamlet);
    this.cells.set(key, site);
    return site;
  }

  /** Settlements in the 3×3 cells around a point. */
  nearby(x: number, z: number): Settlement[] {
    const ci = Math.floor(x / S.cellSize), cj = Math.floor(z / S.cellSize);
    const key = cellKey(ci, cj);
    let list = this.nearCache.get(key);
    if (!list) {
      list = [];
      for (let j = cj - 1; j <= cj + 1; j++) {
        for (let i = ci - 1; i <= ci + 1; i++) {
          const s = this.at(i, j);
          if (s) list.push(s);
        }
      }
      this.nearCache.set(key, list);
    }
    return list;
  }

  /** Every settlement whose centre lies within `range` of a point. */
  within(x: number, z: number, range: number): Settlement[] {
    const C = S.cellSize;
    const out: Settlement[] = [];
    for (let j = Math.floor((z - range) / C); j <= Math.floor((z + range) / C); j++) {
      for (let i = Math.floor((x - range) / C); i <= Math.floor((x + range) / C); i++) {
        const s = this.at(i, j);
        if (s && Math.hypot(s.x - x, s.z - z) <= range) out.push(s);
      }
    }
    return out;
  }

  /** Build density at a point: 1 downtown, fading smoothly to 0 at the edge of a settlement. */
  density(x: number, z: number): number {
    let best = 0;
    this.last = null;
    for (const s of this.nearby(x, z)) {
      const dx = x - s.x, dz = z - s.z;
      const d2 = (dx * dx + dz * dz) / (s.radius * s.radius);
      if (d2 >= 1) continue;
      const v = PEAK[s.kind] * Math.pow(1 - Math.sqrt(d2), 0.75);
      if (v > best) {
        best = v;
        this.last = s;
      }
    }
    return best;
  }

  /** Level the natural ground toward the settlement's plateau. Water is left alone. */
  flatten(x: number, z: number, h: number): number {
    for (const s of this.nearby(x, z)) {
      const dx = x - s.x, dz = z - s.z;
      const outer = s.radius * S.flattenOuter;
      const d2 = dx * dx + dz * dz;
      if (d2 >= outer * outer) continue;
      const w = (1 - smoothstep(S.flattenInner, S.flattenOuter, Math.sqrt(d2) / s.radius)) * smoothstep(0.2, 4.5, h);
      if (w > 0) h += (s.y + (h - s.y) * S.flattenResidual - h) * w;
    }
    return h;
  }
}

/** Build density a single settlement contributes at a distance `d` from its centre. */
export function densityAt(s: Settlement, d: number): number {
  return d >= s.radius ? 0 : PEAK[s.kind] * Math.pow(1 - d / s.radius, 0.75);
}

/** World → settlement-local street-grid coordinates. */
export function toLocal(s: Settlement, x: number, z: number, out: { u: number; v: number }): void {
  const dx = x - s.x, dz = z - s.z;
  out.u = dx * s.cos + dz * s.sin;
  out.v = -dx * s.sin + dz * s.cos;
}

/** Settlement-local street-grid coordinates → world. */
export function toWorld(s: Settlement, u: number, v: number, out: { x: number; z: number }): void {
  out.x = s.x + u * s.cos - v * s.sin;
  out.z = s.z + u * s.sin + v * s.cos;
}
