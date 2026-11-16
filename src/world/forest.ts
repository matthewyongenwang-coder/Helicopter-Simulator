import { PROPS } from '../data/world';
import { hash2 } from './rng';
import { newSurface } from './terrain';
import type { World } from './world';

/** Floats per tree: x, y, z (relative to the cell corner), scale, type (0 broadleaf, 1 conifer). */
export const TREE_STRIDE = 5;

export interface ForestCell {
  cx: number;
  cz: number;
  x0: number;
  z0: number;
  trees: Float32Array;
}

/**
 * Scatter trees over a square on a jittered grid, keeping each with a probability
 * equal to the local tree cover. Positions are relative to (x0, z0).
 */
export function scatterTrees(world: World, x0: number, z0: number, size: number, spacing: number, salt: number, keep: number, out: number[]): void {
  const surf = newSurface();
  const n = Math.ceil(size / spacing);
  const gx = Math.floor(x0 / spacing), gz = Math.floor(z0 / spacing);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const ix = gx + i, iz = gz + j;
      const h = hash2(ix, iz, world.seed ^ salt);
      const x = (ix + (h & 1023) / 1023) * spacing;
      const z = (iz + ((h >>> 10) & 1023) / 1023) * spacing;
      if (x < x0 || x >= x0 + size || z < z0 || z >= z0 + size) continue;
      world.surfaceAt(x, z, surf);
      const roll = ((h >>> 20) & 4095) / 4095;
      if (roll >= surf.trees * keep) continue;
      const y = world.height(x, z);
      if (y < 0.8) continue;
      const h2 = hash2(iz, ix, world.seed ^ (salt + 99));
      const scale = 0.72 + 0.7 * ((h2 & 255) / 255) ** 1.6;
      const conifer = (h2 >>> 8) / 16777216 < surf.conifer * 0.85 + 0.08 ? 1 : 0;
      out.push(x - x0, y - 0.25, z - z0, scale, conifer);
    }
  }
}

/** Individual trees for one forest cell near the camera. */
export function buildForestCell(world: World, cx: number, cz: number, density = 1): ForestCell {
  const size = PROPS.forestCell;
  const x0 = cx * size, z0 = cz * size;
  const out: number[] = [];
  scatterTrees(world, x0, z0, size, PROPS.treeSpacing, 0x7ee5, density, out);
  return { cx, cz, x0, z0, trees: new Float32Array(out) };
}
