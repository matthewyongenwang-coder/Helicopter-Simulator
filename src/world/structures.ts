import { PROPS, ROADS as R, SETTLEMENTS as S } from '../data/world';
import { scatterTrees } from './forest';
import { RoadKind, type Road } from './roads';
import { hash2, rand2 } from './rng';
import { densityAt, KIND_NAMES, type Settlement } from './settlements';
import type { World } from './world';

export interface Helipad {
  x: number;
  y: number;
  z: number;
  heading: number;
  name: string;
  kind: 'ground' | 'roof';
  settlement: string;
  /** Settlement kind: 0 hamlet … 3 city. */
  rank: number;
  size: number;
}

/** Floats per record in the arrays below. */
export const BOX_STRIDE = 9; // x, y(base), z, sx, sy, sz, yaw, style, seed
export const HOUSE_STRIDE = 9; // x, y(base), z, sx, wall height, sz, yaw, wall colour, roof colour
export const SLAB_STRIDE = 7; // x, y(centre), z, sx, sy, sz, yaw
export const PAD_STRIDE = 5; // x, y, z, yaw, size
export const POLE_STRIDE = 5; // x, y(base), z, yaw, height
export const BOAT_STRIDE = 4; // x, z, yaw, length
export const COLLIDER_STRIDE = 9; // x, y(centre), z, hx, hy, hz, cos, sin, kind

export const enum ColliderKind {
  Building = 0,
  Deck = 1,
  Helipad = 2,
  Mast = 3,
}

/** Everything man-made in one structure cell. Positions are relative to (x0, z0). */
export interface StructureCell {
  cx: number;
  cz: number;
  x0: number;
  z0: number;
  boxes: Float32Array;
  houses: Float32Array;
  slabs: Float32Array;
  ribbonPos: Float32Array;
  /** Per vertex: across (0–1), along (m), kind (0 street, 1 rural road, 2 highway). */
  ribbonUv: Float32Array;
  ribbonIndex: Uint32Array;
  pads: Float32Array;
  /** Lamp head positions, 3 floats each. */
  lights: Float32Array;
  pylons: Float32Array;
  /** Line segments: 6 floats each (two endpoints). */
  wires: Float32Array;
  turbines: Float32Array;
  boats: Float32Array;
  farTrees: Float32Array;
  colliders: Float32Array;
  helipads: Helipad[];
}

interface Lot {
  u: number;
  v: number;
  su: number;
  sv: number;
  height: number;
  /** 0 tower, 1 mid-rise, 2 house. */
  type: number;
  style: number;
  seed: number;
  pad: boolean;
  crown: number;
}

const PLAZA_KU = 0, PLAZA_KV = 0;

function streetHalf(k: number): number {
  return ((k % S.avenueEvery) + S.avenueEvery) % S.avenueEvery === 0 ? S.avenueHalfWidth : S.streetHalfWidth;
}

function local(s: Settlement, u: number, v: number): [number, number] {
  return [s.x + u * s.cos - v * s.sin, s.z + u * s.sin + v * s.cos];
}

/** Whether a city block is built on: inside the settlement, dense enough and on dry, level ground. */
function blockBuilt(world: World, s: Settlement, ku: number, kv: number, cache: Map<number, boolean>): boolean {
  const key = (ku + 512) * 1024 + (kv + 512); // the cache is per settlement
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const [bu, bv] = S.block[s.kind];
  const uc = (ku + 0.5) * bu, vc = (kv + 0.5) * bv;
  let ok = densityAt(s, Math.hypot(uc, vc)) >= S.buildDensity;
  if (ok) {
    const [x, z] = local(s, uc, vc);
    const h = world.groundBase(x, z);
    ok = h > 1.5;
    for (let c = 0; c < 4 && ok; c++) {
      const [qx, qz] = local(s, uc + (c & 1 ? 0.5 : -0.5) * bu, vc + (c & 2 ? 0.5 : -0.5) * bv);
      const hc = world.groundBase(qx, qz);
      if (hc < 0.8 || Math.abs(hc - h) > 5) ok = false;
    }
  }
  cache.set(key, ok);
  return ok;
}

/** Lay out the lots of one block. Decided by hashes and density only, so it is cheap. */
function blockLots(s: Settlement, ku: number, kv: number, out: Lot[]): void {
  out.length = 0;
  if (ku === PLAZA_KU && kv === PLAZA_KV) return; // the heliport plaza
  const [bu, bv] = S.block[s.kind];
  const walk = 2.2;
  const u0 = ku * bu + streetHalf(ku) + walk, u1 = (ku + 1) * bu - streetHalf(ku + 1) - walk;
  const v0 = kv * bv + streetHalf(kv) + walk, v1 = (kv + 1) * bv - streetHalf(kv + 1) - walk;
  const wu = u1 - u0, wv = v1 - v0;
  const dens = densityAt(s, Math.hypot((ku + 0.5) * bu, (kv + 0.5) * bv));
  let type: number, nu: number, nv: number, skip: number, setback: number;
  if (dens >= S.towerDensity) {
    type = 0; nu = Math.max(1, Math.round(wu / 44)); nv = Math.max(1, Math.round(wv / 34)); skip = 0.07; setback = 2.5;
  } else if (dens >= S.midriseDensity) {
    type = 1; nu = Math.max(1, Math.round(wu / 27)); nv = 2; skip = 0.1; setback = 2;
  } else {
    type = 2; nu = Math.max(1, Math.round(wu / 21)); nv = 2;
    // Sparser toward the edge of town.
    skip = 0.12 + 0.55 * (1 - Math.min(1, (dens - S.buildDensity) / (S.midriseDensity - S.buildDensity)));
    setback = 4;
  }
  const lu = wu / nu, lv = wv / nv;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const h = hash2(ku * 64 + i, kv * 64 + j, s.seed ^ 0xb10c);
      const r = (h & 0xffff) / 65536, r2 = ((h >>> 16) & 0xff) / 256, r3 = (h >>> 24) / 256;
      if (r < skip) continue;
      let su = lu - 2 * setback, sv = lv - 2 * setback, height: number, crown = 0;
      if (type === 0) {
        const t = (dens - S.towerDensity) / (1 - S.towerDensity);
        height = 34 + (S.maxTowerHeight - 34) * t * t * Math.pow(r2, 1.4) + 40 * t * r3;
        su *= 0.78 + 0.22 * r3; sv *= 0.78 + 0.22 * r2;
        if (height > 90 && r3 > 0.45) crown = 0.12 + 0.2 * r2;
      } else if (type === 1) {
        const t = (dens - S.midriseDensity) / (S.towerDensity - S.midriseDensity);
        height = 9 + 26 * t * (0.45 + 0.55 * r2) + 7 * r3;
        su *= 0.82 + 0.18 * r3; sv *= 0.8 + 0.2 * r2;
      } else {
        height = 3.1 + 2.7 * (r2 > 0.6 ? 1 : 0) + 0.6 * r3;
        su = Math.min(su, 9 + 6 * r3); sv = Math.min(sv, 8 + 5 * r2);
      }
      if (su < 5 || sv < 5) continue;
      const pad = type !== 2 && Math.min(su, sv) >= 22 && height >= 16 && height <= 150 && !crown && (h % 1000) / 1000 < S.rooftopPadChance;
      out.push({
        u: u0 + (i + 0.5) * lu + (type === 2 ? (r3 - 0.5) * 2 : 0),
        v: v0 + (j + 0.5) * lv + (type === 2 ? (j === 0 ? -1 : 1) * (lv - sv - 2 * setback) * 0.3 : 0),
        su, sv, height, type,
        style: h % 7,
        seed: (h >>> 8) % 1000,
        pad,
        crown,
      });
    }
  }
}

/** Ground and rooftop helipads of one settlement. */
export function settlementHelipads(world: World, s: Settlement): Helipad[] {
  const pads: Helipad[] = [];
  const [bu, bv] = S.block[s.kind];
  const heading = Math.atan2(s.cos, -s.sin); // facing along the local u axis
  const [gx, gz] = local(s, (PLAZA_KU + 0.5) * bu, (PLAZA_KV + 0.5) * bv);
  pads.push({ x: gx, y: world.height(gx, gz) + 0.12, z: gz, heading, name: `${s.name} Heliport`, kind: 'ground', settlement: s.name, rank: s.kind, size: 22 });
  const cache = new Map<number, boolean>();
  const lots: Lot[] = [];
  const nu = Math.ceil(s.radius / bu), nv = Math.ceil(s.radius / bv);
  let roof = 0;
  for (let kv = -nv; kv < nv; kv++) {
    for (let ku = -nu; ku < nu; ku++) {
      blockLots(s, ku, kv, lots);
      for (const lot of lots) {
        if (!lot.pad || !blockBuilt(world, s, ku, kv, cache)) continue;
        const [x, z] = local(s, lot.u, lot.v);
        const g = world.height(x, z);
        if (g < 1.2) continue;
        const road = world.roadAt(x, z);
        if (road && road.d < road.road!.halfWidth + Math.max(lot.su, lot.sv) * 0.6 + 2) continue;
        roof++;
        pads.push({
          x, z,
          y: g + lot.height + 0.1,
          heading,
          name: `${s.name} Rooftop ${roof}`,
          kind: 'roof',
          settlement: s.name,
          rank: s.kind,
          size: Math.min(20, Math.min(lot.su, lot.sv) * 0.8),
        });
      }
    }
  }
  return pads;
}

/** Helipads of every settlement within `range` of a point, nearest first. */
export function helipadsNear(world: World, x: number, z: number, range: number): Helipad[] {
  const pads: Helipad[] = [];
  for (const s of world.settlements.within(x, z, range)) pads.push(...settlementHelipads(world, s));
  pads.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
  return pads;
}

interface Pylon {
  x: number;
  y: number;
  z: number;
  yaw: number;
  ok: boolean;
}

const pylonCache = new WeakMap<Road, Pylon[]>();

/** Pylon positions along a road that carries a power line (empty if it does not). */
function roadPylons(world: World, road: Road): Pylon[] {
  let list = pylonCache.get(road);
  if (list) return list;
  list = [];
  if (rand2(road.id, 1, 0x70ad) < PROPS.powerLineChance) {
    const side = rand2(road.id, 2, 0x70ad) < 0.5 ? -1 : 1;
    let next = PROPS.pylonSpacing * 0.5;
    for (const p of road.points) {
      if (p.s < next) continue;
      next += PROPS.pylonSpacing;
      const x = p.x + p.nx * PROPS.pylonOffset * side, z = p.z + p.nz * PROPS.pylonOffset * side;
      const y = world.height(x, z);
      const ok = y > 1.5 && world.density(x, z) < 0.04;
      // Cross-arm (local X) lies across the line, i.e. along the road's side vector.
      list.push({ x, y, z, yaw: Math.atan2(-p.nz, p.nx), ok });
    }
  }
  pylonCache.set(road, list);
  return list;
}

/** Generate everything man-made in structure cell (cx, cz). */
export function buildStructureCell(world: World, cx: number, cz: number): StructureCell {
  const C = PROPS.structureCell;
  const x0 = cx * C, z0 = cz * C, x1 = x0 + C, z1 = z0 + C;
  const inside = (x: number, z: number) => x >= x0 && x < x1 && z >= z0 && z < z1;

  const boxes: number[] = [], houses: number[] = [], slabs: number[] = [], pads: number[] = [], lights: number[] = [];
  const pylons: number[] = [], wires: number[] = [], turbines: number[] = [], boats: number[] = [], colliders: number[] = [];
  const rPos: number[] = [], rUv: number[] = [], rIdx: number[] = [];
  const helipads: Helipad[] = [];

  /** One ribbon quad between a left/right pair at the start and at the end. */
  const quad = (
    lx0: number, ly0: number, lz0: number, rx0: number, ry0: number, rz0: number,
    lx1: number, ly1: number, lz1: number, rx1: number, ry1: number, rz1: number,
    v0: number, v1: number, kind: number,
  ) => {
    const b = rPos.length / 3;
    rPos.push(lx0 - x0, ly0, lz0 - z0, rx0 - x0, ry0, rz0 - z0, lx1 - x0, ly1, lz1 - z0, rx1 - x0, ry1, rz1 - z0);
    rUv.push(0, v0, kind, 1, v0, kind, 0, v1, kind, 1, v1, kind);
    rIdx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  };
  const collider = (x: number, y: number, z: number, hx: number, hy: number, hz: number, cos: number, sin: number, kind: ColliderKind) =>
    colliders.push(x - x0, y, z - z0, hx, hy, hz, cos, sin, kind);

  // --- Settlements: blocks, lots, streets --------------------------------------
  const lots: Lot[] = [];
  for (const s of world.settlements.within(x0 + C / 2, z0 + C / 2, C * 0.71 + S.radius[3][1])) {
    const [bu, bv] = S.block[s.kind];
    const built = new Map<number, boolean>();
    const yaw = -Math.atan2(s.sin, s.cos);
    // Range of block indices that can touch this cell.
    let ku0 = Infinity, ku1 = -Infinity, kv0 = Infinity, kv1 = -Infinity;
    for (const [qx, qz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
      const dx = qx - s.x, dz = qz - s.z;
      const u = dx * s.cos + dz * s.sin, v = -dx * s.sin + dz * s.cos;
      ku0 = Math.min(ku0, u); ku1 = Math.max(ku1, u); kv0 = Math.min(kv0, v); kv1 = Math.max(kv1, v);
    }
    const lim = s.radius;
    ku0 = Math.floor(Math.max(ku0, -lim) / bu) - 1; ku1 = Math.ceil(Math.min(ku1, lim) / bu) + 1;
    kv0 = Math.floor(Math.max(kv0, -lim) / bv) - 1; kv1 = Math.ceil(Math.min(kv1, lim) / bv) + 1;
    if (ku0 > ku1 || kv0 > kv1) continue;

    for (let kv = kv0; kv <= kv1; kv++) {
      for (let ku = ku0; ku <= ku1; ku++) {
        // Buildings of the block whose centre is in this cell.
        const [bx, bz] = local(s, (ku + 0.5) * bu, (kv + 0.5) * bv);
        if (inside(bx, bz) && blockBuilt(world, s, ku, kv, built)) {
          if (ku === PLAZA_KU && kv === PLAZA_KV) {
            const y = world.height(bx, bz) + 0.12;
            pads.push(bx - x0, y, bz - z0, yaw, 22);
            helipads.push({ x: bx, y, z: bz, heading: Math.atan2(s.cos, -s.sin), name: `${s.name} Heliport`, kind: 'ground', settlement: s.name, rank: s.kind, size: 22 });
          }
          blockLots(s, ku, kv, lots);
          for (const lot of lots) {
            const [x, z] = local(s, lot.u, lot.v);
            const g = world.height(x, z);
            if (g < 1.2) continue;
            const road = world.roadAt(x, z);
            if (road && road.d < road.road!.halfWidth + Math.max(lot.su, lot.sv) * 0.6 + 2) continue;
            if (lot.type === 2) {
              houses.push(x - x0, g - 0.4, z - z0, lot.su, lot.height + 0.4, lot.sv, yaw, lot.style, lot.seed % 5);
              const top = lot.height + Math.min(lot.su, lot.sv) * 0.3;
              collider(x, g + top / 2, z, lot.su / 2, top / 2, lot.sv / 2, s.cos, s.sin, ColliderKind.Building);
            } else {
              const body = lot.crown ? lot.height * (1 - lot.crown) : lot.height;
              boxes.push(x - x0, g - 0.6, z - z0, lot.su, body + 0.6, lot.sv, yaw, lot.style + (lot.type === 0 ? 8 : 0), lot.seed);
              collider(x, g + body / 2, z, lot.su / 2, body / 2, lot.sv / 2, s.cos, s.sin, ColliderKind.Building);
              if (lot.crown) {
                const ch = lot.height - body;
                boxes.push(x - x0, g + body, z - z0, lot.su * 0.62, ch, lot.sv * 0.62, yaw, lot.style + 8, lot.seed + 1);
                collider(x, g + body + ch / 2, z, lot.su * 0.31, ch / 2, lot.sv * 0.31, s.cos, s.sin, ColliderKind.Building);
              }
              if (lot.pad) {
                const size = Math.min(20, Math.min(lot.su, lot.sv) * 0.8);
                pads.push(x - x0, g + lot.height + 0.1, z - z0, yaw, size);
              }
            }
          }
        }

        // Street along the u = ku·bu line, between v = kv·bv and (kv+1)·bv.
        for (let axis = 0; axis < 2; axis++) {
          const along = axis === 0;
          const [mx, mz] = along ? local(s, ku * bu, (kv + 0.5) * bv) : local(s, (ku + 0.5) * bu, kv * bv);
          if (!inside(mx, mz)) continue;
          const exists = along
            ? blockBuilt(world, s, ku - 1, kv, built) || blockBuilt(world, s, ku, kv, built)
            : blockBuilt(world, s, ku, kv - 1, built) || blockBuilt(world, s, ku, kv, built);
          if (!exists || world.groundBase(mx, mz) < 1.0) continue;
          const w = streetHalf(along ? ku : kv);
          const len = along ? bv : bu;
          const lift = along ? 0.18 : 0.21;
          const pieces = 4;
          let pl: number[] | null = null;
          for (let k = 0; k <= pieces; k++) {
            const t = (k / pieces) * len;
            const [lx, lz] = along ? local(s, ku * bu - w, kv * bv + t) : local(s, ku * bu + t, kv * bv + w);
            const [rx, rz] = along ? local(s, ku * bu + w, kv * bv + t) : local(s, ku * bu + t, kv * bv - w);
            const cur = [lx, world.height(lx, lz) + lift, lz, rx, world.height(rx, rz) + lift, rz];
            if (pl) quad(pl[0], pl[1], pl[2], pl[3], pl[4], pl[5], cur[0], cur[1], cur[2], cur[3], cur[4], cur[5], ((k - 1) / pieces) * len, t, 0);
            pl = cur;
          }
          // Street lights on alternating sides.
          if (s.kind >= 1 && densityAt(s, Math.hypot(mx - s.x, mz - s.z)) > 0.14) {
            const count = Math.max(1, Math.round(len / S.lightSpacing));
            for (let k = 0; k < count; k++) {
              const t = ((k + 0.5) / count) * len;
              const sideSign = (k + ku + kv) & 1 ? 1 : -1;
              const [lx, lz] = along ? local(s, ku * bu + sideSign * (w + 1), kv * bv + t) : local(s, ku * bu + t, kv * bv + sideSign * (w + 1));
              lights.push(lx - x0, world.height(lx, lz) + 8.5, lz - z0);
            }
          }
        }
      }
    }
  }

  // --- Roads between settlements, and their bridges ----------------------------
  for (const road of world.roads.inRect(x0, z0, x1, z1, 120)) {
    const hw = road.halfWidth;
    const kind = road.kind === RoadKind.Highway ? 2 : 1;
    const P = road.points;
    for (let i = 0; i < P.length - 1; i++) {
      const p = P[i], q = P[i + 1];
      const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2;
      if (!inside(mx, mz)) continue;
      const lift = 0.24;
      quad(
        p.x - p.nx * hw, p.y + lift, p.z - p.nz * hw, p.x + p.nx * hw, p.y + lift, p.z + p.nz * hw,
        q.x - q.nx * hw, q.y + lift, q.z - q.nz * hw, q.x + q.nx * hw, q.y + lift, q.z + q.nz * hw,
        p.s, q.s, kind,
      );
      const dx = q.x - p.x, dz = q.z - p.z;
      const len = Math.hypot(dx, dz);
      const tx = dx / len, tz = dz / len;
      const yaw = Math.atan2(-tz, tx);
      const my = (p.y + q.y) / 2;
      if (p.bridge) {
        // Deck girder, railings, and a pier wherever the spacing comes round.
        slabs.push(mx - x0, my - 0.95, mz - z0, len + 0.6, 1.5, 2 * hw + 1.4, yaw);
        for (const side of [-1, 1]) {
          slabs.push(mx + p.nx * side * (hw + 0.45) - x0, my + 0.75, mz + p.nz * side * (hw + 0.45) - z0, len + 0.6, 1.1, 0.25, yaw);
        }
        if (Math.floor(p.s / R.pierSpacing) !== Math.floor(q.s / R.pierSpacing)) {
          const bed = Math.min(world.groundBase(mx, mz), 0) - 2;
          slabs.push(mx - x0, (my - 1.4 + bed) / 2, mz - z0, 2.4, my - 1.4 - bed, 2 * hw * 0.75, yaw);
        }
        collider(mx, my + lift - 0.8, mz, len / 2 + 0.4, 0.8, hw + 0.7, tx, tz, ColliderKind.Deck);
      }
      // Lights along highways close to town.
      if (kind === 2 && (i & 1) === 0 && !p.bridge) {
        const near = Math.min(Math.hypot(p.x - road.a.x, p.z - road.a.z) / road.a.radius, Math.hypot(p.x - road.b.x, p.z - road.b.z) / road.b.radius);
        if (near < 1.5) {
          const side = (i & 2) === 0 ? 1 : -1;
          lights.push(p.x + p.nx * side * (hw + 1.2) - x0, p.y + 9.5, p.z + p.nz * side * (hw + 1.2) - z0);
        }
      }
    }

    // Towers and cables on long bridges.
    for (const [b0, b1] of road.bridges) {
      const span = P[b1].s - P[b0].s;
      if (span < R.towerSpan) continue;
      const towerH = 34 + 0.07 * span;
      for (const frac of [0.3, 0.7]) {
        const ti = Math.round(b0 + (b1 - b0) * frac);
        const t = P[ti];
        if (!inside(t.x, t.z)) continue;
        const dirX = -t.nz, dirZ = t.nx; // along the road
        const yaw = Math.atan2(-dirZ, dirX);
        for (const side of [-1, 1]) {
          const lx = t.x + t.nx * side * (hw + 1.6), lz = t.z + t.nz * side * (hw + 1.6);
          slabs.push(lx - x0, (t.y + towerH - 12) / 2, lz - z0, 2.6, t.y + towerH + 12, 2.6, yaw);
          collider(lx, (t.y + towerH - 12) / 2, lz, 1.3, (t.y + towerH + 12) / 2, 1.3, dirX, dirZ, ColliderKind.Mast);
          // Cables fanning down to the deck on both sides of the tower.
          const reach = Math.round((b1 - b0) * 0.28);
          for (let k = 2; k <= reach; k += 2) {
            for (const dir of [-1, 1]) {
              const d = P[Math.min(b1, Math.max(b0, ti + dir * k))];
              wires.push(
                lx - x0, t.y + towerH * (0.55 + 0.45 * (k / reach)), lz - z0,
                d.x + d.nx * side * (hw + 0.6) - x0, d.y + 1.2, d.z + d.nz * side * (hw + 0.6) - z0,
              );
            }
          }
        }
        // Cross beam.
        slabs.push(t.x - x0, t.y + towerH - 3, t.z - z0, 1.8, 2.2, 2 * hw + 4, yaw);
      }
    }

    // Power line running beside the road.
    const py = roadPylons(world, road);
    const H = PROPS.pylonHeight;
    for (let i = 0; i < py.length; i++) {
      const a = py[i];
      if (!a.ok || !inside(a.x, a.z)) continue;
      pylons.push(a.x - x0, a.y - 0.5, a.z - z0, a.yaw, H);
      collider(a.x, a.y + H / 2, a.z, 1.6, H / 2, 1.6, 1, 0, ColliderKind.Mast);
      const b = py[i + 1];
      if (!b || !b.ok) continue;
      // Three conductors with a little sag.
      const ca = Math.cos(a.yaw), sa = Math.sin(a.yaw), cb = Math.cos(b.yaw), sb = Math.sin(b.yaw);
      for (const arm of [-7, 0, 7]) {
        const ax = a.x + ca * arm, az = a.z - sa * arm, bx = b.x + cb * arm, bz = b.z - sb * arm;
        const ay = a.y + H - (arm === 0 ? 0.5 : 4), by = b.y + H - (arm === 0 ? 0.5 : 4);
        const seg = 6;
        for (let k = 0; k < seg; k++) {
          const t0 = k / seg, t1 = (k + 1) / seg;
          const sag = (t: number) => -6 * 4 * t * (1 - t);
          wires.push(
            ax + (bx - ax) * t0 - x0, ay + (by - ay) * t0 + sag(t0), az + (bz - az) * t0 - z0,
            ax + (bx - ax) * t1 - x0, ay + (by - ay) * t1 + sag(t1), az + (bz - az) * t1 - z0,
          );
        }
      }
    }
  }

  // --- Wind farm ----------------------------------------------------------------
  const cellHash = hash2(cx, cz, world.seed ^ 0x61d);
  if ((cellHash & 0xffff) / 65536 < PROPS.windFarmChance) {
    const count = 4 + (cellHash >>> 16) % 6;
    const ang = ((cellHash >>> 20) & 255) / 255 * Math.PI;
    const ox = x0 + C * (0.3 + 0.4 * (((cellHash >>> 8) & 255) / 255)), oz = z0 + C * (0.3 + 0.4 * (((cellHash >>> 4) & 255) / 255));
    for (let k = 0; k < count; k++) {
      const row = k % 2, col = Math.floor(k / 2);
      const u = (col - count / 4) * 210, v = row * 260 - 130;
      const x = ox + u * Math.cos(ang) - v * Math.sin(ang), z = oz + u * Math.sin(ang) + v * Math.cos(ang);
      const y = world.height(x, z);
      if (y < 20 || y > 380 || world.density(x, z) > 0) continue;
      if (Math.abs(world.height(x + 20, z) - y) > 9 || Math.abs(world.height(x, z + 20) - y) > 9) continue;
      const H = PROPS.turbineHeight * (0.9 + 0.2 * rand2(cx * 16 + k, cz, world.seed));
      turbines.push(x - x0, y - 1, z - z0, ang + 0.4, H);
      collider(x, y + H / 2, z, 2.2, H / 2, 2.2, 1, 0, ColliderKind.Mast);
    }
  }

  // --- Boats ----------------------------------------------------------------------
  let harbour: Settlement | null = null;
  for (const s of world.settlements.within(x0 + C / 2, z0 + C / 2, C + 2.5 * S.radius[3][1])) {
    if (s.kind >= 1 && Math.hypot(s.x - (x0 + C / 2), s.z - (z0 + C / 2)) < 2.4 * s.radius + C * 0.7) harbour = s;
  }
  const tries = harbour ? PROPS.harbourBoats : (cellHash >>> 9) % 1000 < PROPS.loneBoatChance * 1000 ? 1 : 0;
  for (let k = 0; k < tries; k++) {
    const x = x0 + rand2(cx * 8 + k, cz, world.seed ^ 0xb0a7) * C, z = z0 + rand2(cx, cz * 8 + k, world.seed ^ 0xb0a8) * C;
    if (world.height(x, z) > -2.5) continue;
    if (harbour && Math.hypot(x - harbour.x, z - harbour.z) > 2.6 * harbour.radius) continue;
    const r = rand2(cx * 8 + k, cz * 8 + k, world.seed ^ 0xb0a9);
    boats.push(x - x0, z - z0, r * Math.PI * 2, 7 + 22 * r * r);
  }

  // --- Distant trees --------------------------------------------------------------
  const far: number[] = [];
  scatterTrees(world, x0, z0, C, PROPS.farTreeSpacing, 0xfa27, 0.9, far);

  // Helipads double as landable colliders so the gear rests on the painted surface.
  for (let i = 0; i < pads.length; i += PAD_STRIDE) {
    collider(pads[i] + x0, pads[i + 1] - 0.15, pads[i + 2] + z0, pads[i + 4] / 2, 0.15, pads[i + 4] / 2, Math.cos(-pads[i + 3]), Math.sin(-pads[i + 3]), ColliderKind.Helipad);
  }

  return {
    cx, cz, x0, z0,
    boxes: new Float32Array(boxes),
    houses: new Float32Array(houses),
    slabs: new Float32Array(slabs),
    ribbonPos: new Float32Array(rPos),
    ribbonUv: new Float32Array(rUv),
    ribbonIndex: new Uint32Array(rIdx),
    pads: new Float32Array(pads),
    lights: new Float32Array(lights),
    pylons: new Float32Array(pylons),
    wires: new Float32Array(wires),
    turbines: new Float32Array(turbines),
    boats: new Float32Array(boats),
    farTrees: new Float32Array(far),
    colliders: new Float32Array(colliders),
    helipads,
  };
}

/** Human-readable summary of a settlement, for the spawn menu and minimap. */
export function describeSettlement(s: Settlement): string {
  return `${s.name} (${KIND_NAMES[s.kind]})`;
}
