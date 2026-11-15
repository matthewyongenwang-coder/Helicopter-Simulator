import { TUNING } from '../data/tuning';
import { Vec3 } from './math';
import { SurfaceKind, type Environment, type SurfaceHit } from './types';

export function airDensity(y: number): number {
  return TUNING.atmosphere.rho0 * Math.exp(-Math.max(-500, y) / TUNING.atmosphere.scaleHeight);
}

// ---------------------------------------------------------------------------
// Gust field: smooth 4-D value noise, self-contained so the sim has no
// dependency on the world module.
// ---------------------------------------------------------------------------

function hash4(x: number, y: number, z: number, w: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1) ^ Math.imul(w, 0x85ebca6b) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296 - 0.5;
}
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
/** Smooth noise in roughly [−0.5, 0.5]. */
function noise4(x: number, y: number, z: number, w: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), wi = Math.floor(w);
  const fx = fade(x - xi), fy = fade(y - yi), fz = fade(z - zi), fw = fade(w - wi);
  let acc = 0;
  for (let c = 0; c < 16; c++) {
    const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1, dw = (c >> 3) & 1;
    const wgt = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz) * (dw ? fw : 1 - fw);
    acc += wgt * hash4(xi + dx, yi + dy, zi + dz, wi + dw, seed);
  }
  return acc;
}

export interface WindState {
  /** Mean wind the air is moving toward, m/s (world X/Z). */
  x: number;
  z: number;
  /** RMS-ish gust speed, m/s. */
  gust: number;
}

/**
 * Mean wind with a surface boundary layer plus a two-octave gust field.
 * Deterministic in (position, time, seed).
 */
export function sampleWind(w: WindState, agl: number, x: number, y: number, z: number, t: number, seed: number, out: Vec3): void {
  // Wind slows near the surface.
  const shear = 0.45 + 0.55 * Math.min(1, Math.max(0, agl) / 60) ** 0.35;
  out.x = w.x * shear;
  out.y = 0;
  out.z = w.z * shear;
  if (w.gust > 0.01) {
    const g = w.gust * 2.4;
    const s1 = 1 / 140, s2 = 1 / 38;
    const t1 = t * 0.11, t2 = t * 0.37;
    out.x += g * (noise4(x * s1, y * s1, z * s1, t1, seed) + 0.5 * noise4(x * s2, y * s2, z * s2, t2, seed + 11));
    out.y += g * 0.6 * (noise4(x * s1, y * s1, z * s1, t1, seed + 23) + 0.5 * noise4(x * s2, y * s2, z * s2, t2, seed + 37));
    out.z += g * (noise4(x * s1, y * s1, z * s1, t1, seed + 41) + 0.5 * noise4(x * s2, y * s2, z * s2, t2, seed + 53));
  }
}

/** Flat ground at a fixed height. Used by the physics tests. */
export class FlatEnvironment implements Environment {
  groundHeight = 0;
  windState: WindState = { x: 0, z: 0, gust: 0 };
  seed = 1;
  /** Optional strip of water for contact tests: x > waterFromX is water at height 0. */
  waterFromX = Infinity;

  surface(x: number, _z: number, _y: number, out: SurfaceHit): void {
    if (x > this.waterFromX) {
      out.height = this.groundHeight;
      out.kind = SurfaceKind.Water;
    } else {
      out.height = this.groundHeight;
      out.kind = SurfaceKind.Terrain;
    }
    out.nx = 0; out.ny = 1; out.nz = 0;
  }
  wind(x: number, y: number, z: number, t: number, out: Vec3): void {
    sampleWind(this.windState, y - this.groundHeight, x, y, z, t, this.seed, out);
  }
  density(y: number): number {
    return airDensity(y);
  }
}
