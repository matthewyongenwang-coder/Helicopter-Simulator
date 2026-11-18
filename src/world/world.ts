import { COMPOUNDS } from '../data/weapons';
import { Biome, ROADS } from '../data/world';
import { compoundInCell, type CompoundSite } from './compounds';
import { newRoadHit, Roads, type RoadHit } from './roads';
import { Settlements } from './settlements';
import { newSample, newSurface, smoothstep, Terrain, type Surface, type TerrainSample } from './terrain';

export interface GroundNormal {
  nx: number;
  ny: number;
  nz: number;
}

/**
 * The generated world: natural terrain with settlements and roads layered on.
 * A pure function of the seed, so it runs unchanged on the main thread, in
 * workers and in tests.
 */
export class World {
  readonly seed: number;
  readonly terrain: Terrain;
  readonly settlements: Settlements;
  readonly roads: Roads;
  private s = newSample();
  private sBase = newSample();
  private surf = newSurface();
  private hit = newRoadHit();
  private compoundCells = new Map<number, CompoundSite | null>();
  private lastCell = NaN;
  private lastSite: CompoundSite | null = null;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.terrain = new Terrain(this.seed);
    this.settlements = new Settlements(this.terrain, this.seed);
    this.roads = new Roads(this.settlements, (x, z) => this.groundBase(x, z), this.seed);
  }

  /** Ground with settlements levelled but before any road is cut into it. */
  groundBase(x: number, z: number): number {
    return this.settlements.flatten(x, z, this.terrain.sample(x, z, 0, this.sBase));
  }

  /** Ground height including man-made changes. Negative means under water. */
  height(x: number, z: number): number {
    return this.sample(x, z, 0, this.s);
  }

  /**
   * Height with the intermediate terrain fields. `minWavelength` drops detail
   * finer than that; road beds are skipped once they are too narrow to resolve.
   */
  sample(x: number, z: number, minWavelength: number, out: TerrainSample): number {
    let h = this.settlements.flatten(x, z, this.terrain.sample(x, z, minWavelength, out));
    if (minWavelength < 44 && h > -1) {
      const hit = this.hit;
      // On a bridge the ground is left alone, except where a bank stands higher than the deck:
      // there the road is cut through it.
      if (this.roads.nearest(x, z, hit) && (!hit.bridge || h > hit.y)) {
        const inner = hit.road!.halfWidth + ROADS.shoulder;
        if (hit.d < inner + ROADS.blend) {
          const t = smoothstep(inner, inner + ROADS.blend, hit.d);
          h = hit.y - 0.06 + (h - (hit.y - 0.06)) * t;
        }
      }
    }
    out.h = h;
    return h;
  }

  /**
   * The compound whose generation cell holds this point, if any. A compound
   * keeps well inside its cell, so its yard never crosses into the next one.
   */
  compoundAt(x: number, z: number): CompoundSite | null {
    const C = COMPOUNDS.cell;
    const key = (Math.floor(x / C) + 32768) * 65536 + (Math.floor(z / C) + 32768);
    if (key === this.lastCell) return this.lastSite;
    let site = this.compoundCells.get(key);
    if (site === undefined) {
      site = compoundInCell(this, Math.floor(x / C), Math.floor(z / C));
      if (this.compoundCells.size > 4000) this.compoundCells.clear();
      this.compoundCells.set(key, site);
    }
    this.lastCell = key;
    this.lastSite = site;
    return site;
  }

  /** Nearest road to a point. The returned object is reused between calls. */
  roadAt(x: number, z: number): RoadHit | null {
    return this.roads.nearest(x, z, this.hit) ? this.hit : null;
  }

  /** Build density 0–1 at a point. */
  density(x: number, z: number): number {
    return this.settlements.density(x, z);
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

  /**
   * Biome, colour and tree cover for a point whose height, slope and terrain
   * fields are known: the natural classification, then towns and road verges.
   */
  classify(x: number, z: number, h: number, slope: number, s: TerrainSample, out: Surface): void {
    this.terrain.classify(x, z, h, slope, s, out);
    if (h < 0) return;
    const dens = this.settlements.density(x, z);
    if (dens > 0.02) {
      // Lawns and yards in the suburbs, paving downtown.
      const paved = smoothstep(0.3, 0.75, dens);
      const k = smoothstep(0.02, 0.16, dens);
      const lr = 0.33 + (0.47 - 0.33) * paved, lg = 0.46 + (0.47 - 0.46) * paved, lb = 0.24 + (0.46 - 0.24) * paved;
      out.r += (lr - out.r) * k;
      out.g += (lg - out.g) * k;
      out.b += (lb - out.b) * k;
      if (k > 0.5) out.biome = Biome.Urban;
      out.trees *= 1 - smoothstep(0.03, 0.14, dens);
    }
    // Compounds stand in a cleared, trampled yard.
    const site = this.compoundAt(x, z);
    if (site) {
      const dx = x - site.x, dz = z - site.z;
      const c = Math.cos(site.yaw), sn = Math.sin(site.yaw);
      const m = Math.max(Math.abs(dx * c - dz * sn), Math.abs(dx * sn + dz * c));
      if (m < site.half + 30) {
        const k = 1 - smoothstep(site.half + 4, site.half + 30, m);
        out.trees *= 1 - k;
        const d = k * 0.8;
        out.r += (0.5 - out.r) * d;
        out.g += (0.44 - out.g) * d;
        out.b += (0.33 - out.b) * d;
      }
    }
    const hit = this.hit;
    if (this.roads.nearest(x, z, hit) && !hit.bridge && hit.d < hit.road!.halfWidth + 9) {
      // Gravel verge beside the road; no trees on or next to it.
      const k = 1 - smoothstep(hit.road!.halfWidth, hit.road!.halfWidth + 5, hit.d);
      out.r += (0.4 - out.r) * k * 0.7;
      out.g += (0.39 - out.g) * k * 0.7;
      out.b += (0.36 - out.b) * k * 0.7;
      out.trees = 0;
    }
  }

  /** Biome, colour and tree cover at a point (computes height and slope itself). */
  surfaceAt(x: number, z: number, out: Surface = this.surf): Surface {
    const s = newSample();
    const eps = 3;
    const dx = this.height(x + eps, z) - this.height(x - eps, z);
    const dz = this.height(x, z + eps) - this.height(x, z - eps);
    const h = this.sample(x, z, 0, s);
    this.classify(x, z, h, Math.hypot(dx, dz) / (2 * eps), s, out);
    return out;
  }
}
