import type { SphereContact } from '../sim/types';
import { COLLIDER_STRIDE } from '../world/structures';

const BUCKET = 64;
const bucketKey = (i: number, j: number) => (i + 33554432) * 67108864 + (j + 33554432);

interface CellData {
  x0: number;
  z0: number;
  data: Float32Array;
  keys: number[];
}

interface Entry {
  cell: CellData;
  /** Offset of the box in the cell's data. */
  o: number;
}

/**
 * Oriented boxes for everything solid that is not terrain: buildings, bridge
 * decks, helipads, masts. Boxes arrive per structure cell as the world streams
 * in and are indexed in a grid so the flight model's queries stay cheap.
 */
export class ColliderSet {
  private cells = new Map<string, CellData>();
  private buckets = new Map<number, Entry[]>();
  /** Kind of the box that produced the last topAt() result. */
  lastKind = 0;
  count = 0;

  add(key: string, x0: number, z0: number, data: Float32Array): void {
    this.remove(key);
    const cell: CellData = { x0, z0, data, keys: [] };
    this.cells.set(key, cell);
    for (let o = 0; o < data.length; o += COLLIDER_STRIDE) {
      const cx = x0 + data[o], cz = z0 + data[o + 2];
      // Radius of the box footprint, whatever its rotation.
      const r = Math.hypot(data[o + 3], data[o + 5]);
      const i0 = Math.floor((cx - r) / BUCKET), i1 = Math.floor((cx + r) / BUCKET);
      const j0 = Math.floor((cz - r) / BUCKET), j1 = Math.floor((cz + r) / BUCKET);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = bucketKey(i, j);
          const list = this.buckets.get(k);
          if (list) list.push({ cell, o });
          else {
            this.buckets.set(k, [{ cell, o }]);
          }
          cell.keys.push(k);
        }
      }
      this.count++;
    }
  }

  remove(key: string): void {
    const cell = this.cells.get(key);
    if (!cell) return;
    this.cells.delete(key);
    this.count -= cell.data.length / COLLIDER_STRIDE;
    for (const k of new Set(cell.keys)) {
      const list = this.buckets.get(k);
      if (!list) continue;
      const kept = list.filter((e) => e.cell !== cell);
      if (kept.length) this.buckets.set(k, kept);
      else this.buckets.delete(k);
    }
  }

  clear(): void {
    this.cells.clear();
    this.buckets.clear();
    this.count = 0;
  }

  /** Highest box top at (x, z) that is not above `yMax`. −Infinity if there is none. */
  topAt(x: number, z: number, yMax: number): number {
    const list = this.buckets.get(bucketKey(Math.floor(x / BUCKET), Math.floor(z / BUCKET)));
    let best = -Infinity;
    if (!list) return best;
    for (let n = 0; n < list.length; n++) {
      const e = list[n], d = e.cell.data, o = e.o;
      const dx = x - (e.cell.x0 + d[o]), dz = z - (e.cell.z0 + d[o + 2]);
      const cos = d[o + 6], sin = d[o + 7];
      if (Math.abs(dx * cos + dz * sin) > d[o + 3] || Math.abs(-dx * sin + dz * cos) > d[o + 5]) continue;
      const top = d[o + 1] + d[o + 4];
      if (top <= yMax && top > best) {
        best = top;
        this.lastKind = d[o + 8];
      }
    }
    return best;
  }

  /** Deepest contact between a sphere and any box. Returns false when clear. */
  sphere(x: number, y: number, z: number, r: number, out: SphereContact): boolean {
    let found = false;
    out.depth = 0;
    const i0 = Math.floor((x - r) / BUCKET), i1 = Math.floor((x + r) / BUCKET);
    const j0 = Math.floor((z - r) / BUCKET), j1 = Math.floor((z + r) / BUCKET);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const list = this.buckets.get(bucketKey(i, j));
        if (!list) continue;
        for (let n = 0; n < list.length; n++) {
          const e = list[n], d = e.cell.data, o = e.o;
          const hx = d[o + 3], hy = d[o + 4], hz = d[o + 5];
          const ly = y - d[o + 1];
          if (Math.abs(ly) > hy + r) continue;
          const dx = x - (e.cell.x0 + d[o]), dz = z - (e.cell.z0 + d[o + 2]);
          const cos = d[o + 6], sin = d[o + 7];
          const lx = dx * cos + dz * sin, lz = -dx * sin + dz * cos;
          if (Math.abs(lx) > hx + r || Math.abs(lz) > hz + r) continue;
          // Closest point on the box, in box axes.
          const qx = lx < -hx ? -hx : lx > hx ? hx : lx;
          const qy = ly < -hy ? -hy : ly > hy ? hy : ly;
          const qz = lz < -hz ? -hz : lz > hz ? hz : lz;
          let nx = lx - qx, ny = ly - qy, nz = lz - qz;
          const dist = Math.hypot(nx, ny, nz);
          let depth: number;
          if (dist > 1e-6) {
            if (dist >= r) continue;
            depth = r - dist;
            nx /= dist; ny /= dist; nz /= dist;
          } else {
            // Centre is inside the box: push out through the nearest face.
            const px = hx - Math.abs(lx), py = hy - Math.abs(ly), pz = hz - Math.abs(lz);
            nx = ny = nz = 0;
            if (px <= py && px <= pz) {
              nx = Math.sign(lx) || 1;
              depth = px + r;
            } else if (py <= pz) {
              ny = Math.sign(ly) || 1;
              depth = py + r;
            } else {
              nz = Math.sign(lz) || 1;
              depth = pz + r;
            }
          }
          if (depth > out.depth) {
            out.depth = depth;
            out.nx = nx * cos - nz * sin;
            out.ny = ny;
            out.nz = nx * sin + nz * cos;
            found = true;
          }
        }
      }
    }
    return found;
  }
}
