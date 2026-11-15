import { rng } from './rng';

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = new Float64Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1, 1, 0.5, -1, 0.5, 1, -0.5, -1, -0.5, 0.5, 1, -0.5, 1, 0.5, -1, -0.5, -1]);

/** Seeded 2-D simplex noise in about [−1, 1]. */
export class Noise2D {
  private perm = new Uint8Array(512);

  constructor(seed: number) {
    const r = rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  get(x: number, y: number): number {
    const perm = this.perm;
    const s = (x + y) * F2;
    const i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t), y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let a = 0.5 - x0 * x0 - y0 * y0;
    if (a > 0) {
      const g = (perm[ii + perm[jj]] & 15) * 2;
      a *= a;
      n += a * a * (GRAD[g] * x0 + GRAD[g + 1] * y0);
    }
    a = 0.5 - x1 * x1 - y1 * y1;
    if (a > 0) {
      const g = (perm[ii + i1 + perm[jj + j1]] & 15) * 2;
      a *= a;
      n += a * a * (GRAD[g] * x1 + GRAD[g + 1] * y1);
    }
    a = 0.5 - x2 * x2 - y2 * y2;
    if (a > 0) {
      const g = (perm[ii + 1 + perm[jj + 1]] & 15) * 2;
      a *= a;
      n += a * a * (GRAD[g] * x2 + GRAD[g + 1] * y2);
    }
    return 62 * n;
  }

  /**
   * Fractal sum. `scale` is the wavelength of the first octave in world units.
   * Octaves whose wavelength is below `minWavelength` are skipped, which is how
   * coarse terrain LODs stay cheap and alias-free. Result is about [−1, 1].
   */
  fbm(x: number, y: number, scale: number, octaves: number, minWavelength = 0, lacunarity = 2.03, gain = 0.5): number {
    let amp = 1, sum = 0, norm = 0, wl = scale;
    for (let o = 0; o < octaves; o++) {
      norm += amp;
      if (wl >= minWavelength) sum += amp * this.get(x / wl + o * 17.31, y / wl - o * 9.73);
      amp *= gain;
      wl /= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged fractal in [0, 1]: sharp crests, used for mountain ranges. */
  ridged(x: number, y: number, scale: number, octaves: number, minWavelength = 0): number {
    let amp = 1, sum = 0, norm = 0, wl = scale, weight = 1;
    for (let o = 0; o < octaves; o++) {
      norm += amp;
      if (wl >= minWavelength) {
        let r = 1 - Math.abs(this.get(x / wl + o * 31.7, y / wl + o * 11.3));
        r *= r * weight;
        weight = Math.min(1, Math.max(0, r * 2));
        sum += amp * r;
      } else {
        sum += amp * 0.25;
      }
      amp *= 0.5;
      wl /= 2.07;
    }
    return sum / norm;
  }
}
