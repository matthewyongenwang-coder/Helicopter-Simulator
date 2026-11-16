import { newSample, newSurface } from './terrain';
import type { World } from './world';

export interface TerrainMeshData {
  /** Vertex positions relative to the node's (x0, 0, z0) corner. Grid first, then skirts. */
  positions: Float32Array;
  /** Unit normals packed as signed bytes. */
  normals: Int8Array;
  /** RGB colours as bytes, plus alpha unused (kept for 4-byte alignment). */
  colors: Uint8Array;
  minY: number;
  maxY: number;
}

/** Number of vertices in a node mesh with `cells` cells per side (grid + skirt ring). */
export function terrainVertexCount(cells: number): number {
  const n = cells + 1;
  return n * n + 4 * n;
}

/**
 * Index buffer for a node mesh. The same for every node with the same
 * resolution, so the renderer builds it once.
 */
export function terrainIndices(cells: number): Uint32Array {
  const n = cells + 1;
  const idx: number[] = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      // Alternate the diagonal for a less directional look.
      if ((i + j) & 1) idx.push(a, c, b, b, c, d);
      else idx.push(a, c, d, a, d, b);
    }
  }
  // Skirts: four strips hanging from the edges.
  const base = n * n;
  const edge = (k: number, e: number) => (e === 0 ? k : e === 1 ? cells * n + k : e === 2 ? k * n : k * n + cells);
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < cells; k++) {
      const a = edge(k, e), b = edge(k + 1, e);
      const sa = base + e * n + k, sb = sa + 1;
      // Winding so the skirt faces outward on every side.
      if (e === 0 || e === 3) idx.push(a, b, sa, b, sb, sa);
      else idx.push(a, sa, b, b, sa, sb);
    }
  }
  return new Uint32Array(idx);
}

/**
 * Build the vertex data for one terrain node covering [x0, x0+size] × [z0, z0+size].
 * Heights finer than twice the cell size are filtered out so coarse LODs do not alias.
 */
export function buildTerrainMesh(world: World, x0: number, z0: number, size: number, cells: number): TerrainMeshData {
  const n = cells + 1;
  const step = size / cells;
  const pad = n + 2;
  const heights = new Float32Array(pad * pad);
  const samples = new Array(n * n);
  const minWl = step * 2;
  const s = newSample();

  // Heights on a grid one cell larger all round, for normals.
  for (let j = 0; j < pad; j++) {
    for (let i = 0; i < pad; i++) {
      heights[j * pad + i] = world.sample(x0 + (i - 1) * step, z0 + (j - 1) * step, minWl, s);
      if (i > 0 && j > 0 && i <= n && j <= n) {
        const k = (j - 1) * n + (i - 1);
        samples[k] = { cont: s.cont, mountain: s.mountain, river: s.river, valley: s.valley, lake: s.lake, h: s.h };
      }
    }
  }

  const count = terrainVertexCount(cells);
  const positions = new Float32Array(count * 3);
  const normals = new Int8Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const surf = newSurface();
  let minY = Infinity, maxY = -Infinity;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const p = (j + 1) * pad + (i + 1);
      const h = heights[p];
      const dx = heights[p - 1] - heights[p + 1];
      const dz = heights[p - pad] - heights[p + pad];
      const len = Math.hypot(dx, 2 * step, dz);
      const nx = dx / len, ny = (2 * step) / len, nz = dz / len;
      positions[k * 3] = i * step;
      positions[k * 3 + 1] = h;
      positions[k * 3 + 2] = j * step;
      normals[k * 3] = Math.round(nx * 127);
      normals[k * 3 + 1] = Math.round(ny * 127);
      normals[k * 3 + 2] = Math.round(nz * 127);
      const slope = Math.hypot(dx, dz) / (2 * step);
      world.classify(x0 + i * step, z0 + j * step, h, slope, samples[k], surf);
      colors[k * 4] = Math.min(255, Math.max(0, Math.round(surf.r * 255)));
      colors[k * 4 + 1] = Math.min(255, Math.max(0, Math.round(surf.g * 255)));
      colors[k * 4 + 2] = Math.min(255, Math.max(0, Math.round(surf.b * 255)));
      colors[k * 4 + 3] = 255;
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
    }
  }

  // Skirts copy the edge vertices and drop them, hiding cracks between LODs.
  const drop = step * 1.5 + size * 0.02;
  const base = n * n;
  const edge = (k: number, e: number) => (e === 0 ? k : e === 1 ? cells * n + k : e === 2 ? k * n : k * n + cells);
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < n; k++) {
      const src = edge(k, e), dst = base + e * n + k;
      positions[dst * 3] = positions[src * 3];
      positions[dst * 3 + 1] = positions[src * 3 + 1] - drop;
      positions[dst * 3 + 2] = positions[src * 3 + 2];
      normals[dst * 3] = normals[src * 3];
      normals[dst * 3 + 1] = normals[src * 3 + 1];
      normals[dst * 3 + 2] = normals[src * 3 + 2];
      colors[dst * 4] = colors[src * 4];
      colors[dst * 4 + 1] = colors[src * 4 + 1];
      colors[dst * 4 + 2] = colors[src * 4 + 2];
      colors[dst * 4 + 3] = 255;
    }
  }
  return { positions, normals, colors, minY: minY - drop, maxY };
}
