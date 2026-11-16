import { airDensity, sampleWind, type WindState } from '../sim/environment';
import type { Vec3 } from '../sim/math';
import { SurfaceKind, type Environment, type SphereContact, type SurfaceHit } from '../sim/types';
import { ColliderKind } from '../world/structures';
import type { World } from '../world/world';
import { ColliderSet } from './colliders';

/**
 * The flight model's view of the generated world: ground height and normal,
 * water, structures, wind. Heights come from the same analytic function the
 * meshes are sampled from, interpolated on a 2 m grid and cached, since the
 * aircraft asks for the same few square metres thousands of times a second
 * near the ground.
 */
export class WorldEnvironment implements Environment {
  wind_: WindState = { x: 0, z: 0, gust: 0 };
  /** Extra gustiness from the terrain under the aircraft (set each frame by the game). */
  turbulence = 0;
  /** Buildings, bridge decks, helipads and masts near the aircraft. */
  readonly colliders = new ColliderSet();
  private cache = new Map<number, number>();
  private lastAgl = 100;
  private static readonly CELL = 2;
  /** How far above a probe point a roof may be and still count as the surface under it, m. */
  private static readonly STEP_UP = 0.75;

  constructor(readonly world: World) {}

  private gridHeight(ix: number, iz: number): number {
    // Pack two 26-bit signed cell indices into one double key.
    const key = (ix + 33554432) * 67108864 + (iz + 33554432);
    let h = this.cache.get(key);
    if (h === undefined) {
      if (this.cache.size > 40000) this.cache.clear();
      h = this.world.height(ix * WorldEnvironment.CELL, iz * WorldEnvironment.CELL);
      this.cache.set(key, h);
    }
    return h;
  }

  /** Ground height (not water level, not roofs) at a point. */
  ground(x: number, z: number): number {
    const c = WorldEnvironment.CELL;
    const fx = x / c, fz = z / c;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const h00 = this.gridHeight(ix, iz), h10 = this.gridHeight(ix + 1, iz);
    const h01 = this.gridHeight(ix, iz + 1), h11 = this.gridHeight(ix + 1, iz + 1);
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  surface(x: number, z: number, y: number, out: SurfaceHit): void {
    const c = WorldEnvironment.CELL;
    const fx = x / c, fz = z / c;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const h00 = this.gridHeight(ix, iz), h10 = this.gridHeight(ix + 1, iz);
    const h01 = this.gridHeight(ix, iz + 1), h11 = this.gridHeight(ix + 1, iz + 1);
    const h = (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
    if (h < 0) {
      out.height = 0;
      out.nx = 0; out.ny = 1; out.nz = 0;
      out.kind = SurfaceKind.Water;
    } else {
      const dx = ((h10 - h00) * (1 - tz) + (h11 - h01) * tz) / c;
      const dz = ((h01 - h00) * (1 - tx) + (h11 - h10) * tx) / c;
      const l = Math.hypot(dx, 1, dz);
      out.height = h;
      out.nx = -dx / l; out.ny = 1 / l; out.nz = -dz / l;
      out.kind = SurfaceKind.Terrain;
    }
    // A roof, deck or pad under the probe point takes over from the ground below it.
    if (this.colliders.count > 0) {
      const top = this.colliders.topAt(x, z, y + WorldEnvironment.STEP_UP);
      if (top > out.height) {
        out.height = top;
        out.nx = 0; out.ny = 1; out.nz = 0;
        out.kind = this.colliders.lastKind === ColliderKind.Helipad ? SurfaceKind.Helipad : SurfaceKind.Structure;
      }
    }
  }

  collide(x: number, y: number, z: number, r: number, out: SphereContact): boolean {
    return this.colliders.count > 0 && this.colliders.sphere(x, y, z, r, out);
  }

  /** The game tells the environment how high the aircraft is, for the wind profile. */
  setAgl(agl: number): void {
    this.lastAgl = agl;
  }

  wind(x: number, y: number, z: number, t: number, out: Vec3): void {
    const w = this.wind_;
    if (w.x === 0 && w.z === 0 && w.gust === 0 && this.turbulence === 0) {
      out.set(0, 0, 0);
      return;
    }
    const gust = w.gust + this.turbulence;
    sampleWind(gust === w.gust ? w : { x: w.x, z: w.z, gust }, this.lastAgl, x, y, z, t, this.world.seed, out);
  }

  density(y: number): number {
    return airDensity(y);
  }
}
