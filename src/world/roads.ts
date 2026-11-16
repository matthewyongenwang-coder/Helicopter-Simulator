import { ROADS as R, SETTLEMENTS as S } from '../data/world';
import { Noise2D } from './noise';
import { hash2, rand2 } from './rng';
import { SettlementKind, type Settlement, type Settlements } from './settlements';

export const enum RoadKind {
  Rural = 0,
  Highway = 1,
}

export interface RoadPoint {
  x: number;
  z: number;
  /** Road surface height. */
  y: number;
  /** Unit vector pointing to the right of the direction of travel. */
  nx: number;
  nz: number;
  /** Distance along the road, m. */
  s: number;
  /** The stretch from this point to the next is carried on a bridge. */
  bridge: boolean;
}

export interface Road {
  id: number;
  kind: RoadKind;
  halfWidth: number;
  points: RoadPoint[];
  a: Settlement;
  b: Settlement;
  /** Bridge spans as [first point index, last point index]. */
  bridges: [number, number][];
}

/** Result of a nearest-road query. */
export interface RoadHit {
  road: Road | null;
  /** Index of the segment's first point. */
  index: number;
  /** Position along the segment, 0–1. */
  t: number;
  /** Horizontal distance to the centre line, m. */
  d: number;
  /** Road surface height at the nearest point. */
  y: number;
  bridge: boolean;
}

export function newRoadHit(): RoadHit {
  return { road: null, index: 0, t: 0, d: Infinity, y: 0, bridge: false };
}

interface Seg {
  road: Road;
  i: number;
}

const BUCKET = 64;
const bucketKey = (i: number, j: number) => (i + 33554432) * 67108864 + (j + 33554432);
const cellKey = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
/** Canonical neighbour offsets: each undirected edge is owned by one cell. */
const EDGES: [number, number][] = [[1, 0], [0, 1], [1, 1], [1, -1]];

/**
 * The road network. Neighbouring settlements are linked by wandering splines whose
 * height profile follows the smoothed ground. Where a road crosses water it becomes
 * a bridge. Generated lazily per region and indexed in a grid for fast lookup.
 */
export class Roads {
  private done = new Set<number>();
  private buckets = new Map<number, Seg[]>();
  private all = new Map<number, Road | null>();
  private noise: Noise2D;
  /** Corridor each segment is indexed with: wide enough for the terrain blend. */
  private readonly corridor = R.highway.halfWidth + R.shoulder + R.blend + 2;

  constructor(private settlements: Settlements, private ground: (x: number, z: number) => number, private seed: number) {
    this.noise = new Noise2D(hash2(101, 202, seed));
  }

  /** Build the road from the settlement in cell (ci, cj) along one canonical edge, if there is one. */
  private build(ci: number, cj: number, e: number): Road | null {
    const [di, dj] = EDGES[e];
    const a = this.settlements.at(ci, cj), b = this.settlements.at(ci + di, cj + dj);
    if (!a || !b) return null;
    const id = hash2(ci * 4 + e, cj, this.seed ^ 0xa0ad);
    const chance = e < 2 ? R.orthogonalChance : R.diagonalChance;
    if ((id & 0xffff) / 65536 >= chance) return null;
    // Hamlets only get a road along an orthogonal edge.
    if (e >= 2 && (a.kind === SettlementKind.Hamlet || b.kind === SettlementKind.Hamlet)) return null;

    const kind = a.kind >= SettlementKind.Town && b.kind >= SettlementKind.Town ? RoadKind.Highway : RoadKind.Rural;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const n = Math.max(8, Math.ceil(len / R.spacing));
    const px = -dz / len, pz = dx / len;
    const amp = Math.min(R.wander * len, R.maxWander);
    const off = (id >>> 16) * 0.013;

    const xs = new Float64Array(n + 1), zs = new Float64Array(n + 1), g = new Float64Array(n + 1);
    let run = 0, longest = 0, wet = 0, peak = -Infinity;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      // Sideways wander, pinned to zero at both ends.
      const w = amp * Math.sin(Math.PI * t) * (this.noise.get(t * 2.6 + off, off * 0.37) + 0.45 * this.noise.get(t * 7.1 - off, 3.3));
      xs[i] = a.x + dx * t + px * w;
      zs[i] = a.z + dz * t + pz * w;
      g[i] = this.ground(xs[i], zs[i]);
      peak = Math.max(peak, g[i]);
    }
    // Water crossings: stretches at or below the waterline that actually contain water.
    // A strip of low beach with no water in it is just low ground and gets ordinary fill.
    const water = new Uint8Array(n + 1);
    for (let i = 0; i <= n; i++) {
      if (g[i] >= 0.6) continue;
      let j = i, lowest = Infinity;
      while (j <= n && g[j] < 0.6) lowest = Math.min(lowest, g[j++]);
      if (lowest < 0) {
        for (let k = i; k < j; k++) water[k] = 1;
        wet += j - i;
        longest = Math.max(longest, ((j - i) * len) / n);
      }
      i = j;
    }
    void run;
    if (longest > R.maxBridge || wet / (n + 1) > R.maxWaterFraction || peak > R.maxElevation) return null;

    // Height profile: follow the ground on land, sit at deck height over water, then smooth.
    const raw = new Float64Array(n + 1), y = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) raw[i] = water[i] ? R.deckHeight : Math.max(g[i], 2.2);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i <= n; i++) {
        let sum = 0, cnt = 0;
        for (let k = -R.smooth; k <= R.smooth; k++) {
          const j = Math.min(n, Math.max(0, i + k));
          sum += raw[j];
          cnt++;
        }
        y[i] = sum / cnt;
      }
      raw.set(y);
    }

    // Keep decks clear of the water, then limit the grade by filling (never by digging),
    // so the approach to a bridge becomes a ramp instead of a step.
    const over = new Uint8Array(n + 1);
    const dist = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
      over[i] = water[i] || water[Math.min(n, i + 1)] ? 1 : 0;
      if (over[i]) y[i] = Math.max(y[i], R.minDeck);
      if (i > 0) dist[i] = dist[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
    }
    for (let i = 1; i <= n; i++) y[i] = Math.max(y[i], y[i - 1] - R.maxGrade * (dist[i] - dist[i - 1]));
    for (let i = n - 1; i >= 0; i--) y[i] = Math.max(y[i], y[i + 1] - R.maxGrade * (dist[i + 1] - dist[i]));

    const points: RoadPoint[] = [];
    for (let i = 0; i <= n; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n, i + 1);
      const tx = xs[i1] - xs[i0], tz = zs[i1] - zs[i0];
      const tl = Math.hypot(tx, tz) || 1;
      const s = dist[i];
      const overWater = over[i] === 1;
      points.push({
        x: xs[i], z: zs[i],
        y: y[i],
        nx: -tz / tl, nz: tx / tl,
        s,
        bridge: overWater,
      });
    }
    // Extend each bridge one sample onto each bank so the deck reaches dry ground.
    for (let i = 0; i < n; i++) {
      if (!points[i].bridge && points[i + 1].bridge) points[i].bridge = true;
    }
    for (let i = n - 1; i > 0; i--) {
      if (points[i - 1].bridge && !points[i].bridge && g[i] < 4) {
        points[i].bridge = true;
        break;
      }
    }
    const bridges: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      if (points[i].bridge) {
        let j = i;
        while (j < n && points[j].bridge) j++;
        bridges.push([i, j]);
        i = j;
      }
    }
    return { id, kind, halfWidth: kind === RoadKind.Highway ? R.highway.halfWidth : R.rural.halfWidth, points, a, b, bridges };
  }

  private index(road: Road): void {
    const c = this.corridor;
    for (let i = 0; i < road.points.length - 1; i++) {
      const p = road.points[i], q = road.points[i + 1];
      const i0 = Math.floor((Math.min(p.x, q.x) - c) / BUCKET), i1 = Math.floor((Math.max(p.x, q.x) + c) / BUCKET);
      const j0 = Math.floor((Math.min(p.z, q.z) - c) / BUCKET), j1 = Math.floor((Math.max(p.z, q.z) + c) / BUCKET);
      for (let j = j0; j <= j1; j++) {
        for (let k = i0; k <= i1; k++) {
          const key = bucketKey(k, j);
          const list = this.buckets.get(key);
          if (list) list.push({ road, i });
          else this.buckets.set(key, [{ road, i }]);
        }
      }
    }
  }

  /** Make sure every road that can pass through the settlement cell containing (x, z) exists. */
  private ensure(x: number, z: number): void {
    const ci = Math.floor(x / S.cellSize), cj = Math.floor(z / S.cellSize);
    const key = cellKey(ci, cj);
    if (this.done.has(key)) return;
    this.done.add(key);
    for (let j = cj - 2; j <= cj + 2; j++) {
      for (let i = ci - 2; i <= ci + 1; i++) {
        for (let e = 0; e < EDGES.length; e++) {
          const ek = cellKey(i, j) * 4 + e;
          if (this.all.has(ek)) continue;
          const road = this.build(i, j, e);
          this.all.set(ek, road);
          if (road) this.index(road);
        }
      }
    }
  }

  /** Nearest road to a point, if one is within the indexed corridor. */
  nearest(x: number, z: number, out: RoadHit): boolean {
    this.ensure(x, z);
    const list = this.buckets.get(bucketKey(Math.floor(x / BUCKET), Math.floor(z / BUCKET)));
    out.road = null;
    out.d = Infinity;
    if (!list) return false;
    for (let k = 0; k < list.length; k++) {
      const seg = list[k];
      const p = seg.road.points[seg.i], q = seg.road.points[seg.i + 1];
      const ex = q.x - p.x, ez = q.z - p.z;
      let t = ((x - p.x) * ex + (z - p.z) * ez) / (ex * ex + ez * ez);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (p.x + ex * t), z - (p.z + ez * t));
      if (d < out.d) {
        out.d = d;
        out.road = seg.road;
        out.index = seg.i;
        out.t = t;
        out.y = p.y + (q.y - p.y) * t;
        out.bridge = p.bridge;
      }
    }
    return out.road !== null;
  }

  /** Every road with at least one point inside a rectangle (expanded by `margin`). */
  inRect(x0: number, z0: number, x1: number, z1: number, margin = 0): Road[] {
    // Make sure all cells touching the rectangle have been generated.
    const C = S.cellSize;
    for (let z = z0 - margin; z <= z1 + margin + C; z += C) {
      for (let x = x0 - margin; x <= x1 + margin + C; x += C) this.ensure(Math.min(x, x1 + margin), Math.min(z, z1 + margin));
    }
    const seen = new Set<Road>();
    const i0 = Math.floor((x0 - margin) / BUCKET), i1 = Math.floor((x1 + margin) / BUCKET);
    const j0 = Math.floor((z0 - margin) / BUCKET), j1 = Math.floor((z1 + margin) / BUCKET);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const list = this.buckets.get(bucketKey(i, j));
        if (list) for (const s of list) seen.add(s.road);
      }
    }
    return [...seen];
  }

  /** Stable pseudo-random value per road, for optional features such as power lines. */
  static chance(road: Road, salt: number): number {
    return rand2(road.id, salt, 0x70ad);
  }
}
