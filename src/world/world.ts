import { newSample, newSurface, Terrain, type Surface, type TerrainSample } from './terrain';

export interface GroundNormal {
  nx: number;
  ny: number;
  nz: number;
}

/**
 * The generated world: natural terrain plus (from milestone 3) settlements and
 * roads. A pure function of the seed, so it runs unchanged on the main thread,
 * in workers and in tests.
 */
export class World {
  readonly seed: number;
  readonly terrain: Terrain;
  private s = newSample();
  private surf = newSurface();

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.terrain = new Terrain(this.seed);
  }

  /** Ground height including man-made changes. Negative means under water. */
  height(x: number, z: number): number {
    return this.sample(x, z, 0, this.s);
  }

  /** Height with the intermediate terrain fields. See Terrain.sample. */
  sample(x: number, z: number, minWavelength: number, out: TerrainSample): number {
    return this.terrain.sample(x, z, minWavelength, out);
  }

  /** Unit ground normal by central differences. */
  normal(x: number, z: number, out: GroundNormal, eps = 1.5): GroundNormal {
    const dx = this.height(x - eps, z) - this.height(x + eps, z);
    const dz = this.height(x, z - eps) - this.height(x, z + eps);
    const l = Math.hypot(dx, 2 * eps, dz);
    out.nx = dx / l;
    out.ny = (2 * eps) / l;
    out.nz = dz / l;
    return out;
  }

  /** Biome, colour and tree cover at a point (computes height and slope itself). */
  surfaceAt(x: number, z: number, out: Surface = this.surf): Surface {
    const s = this.s;
    const h = this.sample(x, z, 0, s);
    const eps = 3;
    const dx = this.height(x + eps, z) - this.height(x - eps, z);
    const dz = this.height(x, z + eps) - this.height(x, z - eps);
    // height() reused the scratch sample: refresh it for this point.
    this.sample(x, z, 0, s);
    this.terrain.classify(x, z, h, Math.hypot(dx, dz) / (2 * eps), s, out);
    return out;
  }
}
