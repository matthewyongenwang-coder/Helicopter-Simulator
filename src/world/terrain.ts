import { Biome, BIOME_COLORS, WORLD } from '../data/world';
import { Noise2D } from './noise';
import { hash2 } from './rng';

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Height plus the intermediate fields the biome and prop generators reuse. */
export interface TerrainSample {
  h: number;
  /** Continentalness: < 0 sea, > 0 land. */
  cont: number;
  /** Mountain mask 0–1. */
  mountain: number;
  /** River channel 0–1 and the wider valley 0–1. */
  river: number;
  valley: number;
  /** Lake basin 0–1. */
  lake: number;
}

export function newSample(): TerrainSample {
  return { h: 0, cont: 0, mountain: 0, river: 0, valley: 0, lake: 0 };
}

export interface Surface {
  biome: Biome;
  r: number;
  g: number;
  b: number;
  /** Tree cover 0–1 and whether conifers dominate. */
  trees: number;
  conifer: number;
  moisture: number;
}

export function newSurface(): Surface {
  return { biome: Biome.Plains, r: 0, g: 0, b: 0, trees: 0, conifer: 0, moisture: 0 };
}

const CROPS: [number, number, number][] = [
  [0.47, 0.56, 0.2],
  [0.66, 0.6, 0.27],
  [0.38, 0.5, 0.19],
  [0.56, 0.44, 0.27],
  [0.72, 0.68, 0.36],
  [0.3, 0.45, 0.2],
];

/**
 * Natural terrain: a pure function of (seed, x, z). No settlements or roads;
 * those are layered on in world.ts.
 */
export class Terrain {
  readonly seed: number;
  private nCont: Noise2D;
  private nWarpX: Noise2D;
  private nWarpZ: Noise2D;
  private nHill: Noise2D;
  private nHillVar: Noise2D;
  private nMtnMask: Noise2D;
  private nMtn: Noise2D;
  private nDetail: Noise2D;
  private nRiver: Noise2D;
  private nLake: Noise2D;
  private nMoist: Noise2D;
  private nTemp: Noise2D;
  private nFarm: Noise2D;
  private nTint: Noise2D;
  private scratch = newSample();

  constructor(seed: number) {
    this.seed = seed >>> 0;
    let k = 0;
    const n = () => new Noise2D(hash2(++k, 7919, this.seed));
    this.nCont = n();
    this.nWarpX = n();
    this.nWarpZ = n();
    this.nHill = n();
    this.nHillVar = n();
    this.nMtnMask = n();
    this.nMtn = n();
    this.nDetail = n();
    this.nRiver = n();
    this.nLake = n();
    this.nMoist = n();
    this.nTemp = n();
    this.nFarm = n();
    this.nTint = n();
  }

  height(x: number, z: number): number {
    return this.sample(x, z, 0, this.scratch);
  }

  /**
   * Terrain height at (x, z). `minWavelength` drops octaves finer than that,
   * for coarse LODs. Fills `out` and returns the height.
   */
  sample(x: number, z: number, minWavelength: number, out: TerrainSample): number {
    const P = WORLD;
    const mw = minWavelength;
    const wx = x + P.warp.amount * this.nWarpX.get(x / P.warp.scale, z / P.warp.scale);
    const wz = z + P.warp.amount * this.nWarpZ.get(x / P.warp.scale, z / P.warp.scale);

    // Continents and sea.
    const c = this.nCont.fbm(wx, wz, P.continent.scale, P.continent.octaves, mw) + P.continent.landBias;
    let e =
      c >= 0
        ? P.continent.landRise * Math.pow(c, P.continent.landExponent)
        : -P.continent.seaDepth * Math.pow(-c, P.continent.seaExponent);
    const coast = smoothstep(0.015, 0.2, c);

    // Rolling hills, stronger in some regions.
    if (coast > 0) {
      const hv = 0.5 + 0.5 * this.nHillVar.get(x / P.hills.varScale, z / P.hills.varScale);
      const hn = this.nHill.fbm(x, z, P.hills.scale, P.hills.octaves, mw);
      e += coast * (P.hills.amplitude + P.hills.amplitudeVar * hv * hv) * hn;
    }

    // Mountain ranges, inland only.
    let mm = 0;
    if (c > 0.06) {
      const m = this.nMtnMask.fbm(wx, wz, P.mountains.maskScale, 2, mw) + 0.35 * c;
      mm = smoothstep(P.mountains.maskLow, P.mountains.maskHigh, m) * smoothstep(0.06, 0.3, c);
      if (mm > 0) {
        const r = this.nMtn.ridged(wx, wz, P.mountains.scale, P.mountains.octaves, mw);
        e += mm * (P.mountains.base + P.mountains.height * r * r);
      }
    }

    // Small-scale relief.
    const D = P.detail;
    e += this.nDetail.fbm(x, z, D.scale, D.octaves, Math.max(mw, P.minWavelength)) * (D.amplitude + D.mountainAmplitude * mm) * (0.35 + 0.65 * coast);
    if (mw <= D.microScale) e += this.nDetail.get(x / D.microScale + 91.7, z / D.microScale - 33.1) * D.microAmplitude * coast;

    // Lakes: basins in the lowlands.
    let lake = 0;
    const L = P.lakes;
    if (c > 0.05 && e < L.maxElevation) {
      const ln = this.nLake.get(x / L.scale, z / L.scale);
      if (ln > L.low) {
        lake = smoothstep(L.low, L.high, ln) * smoothstep(0.05, 0.2, c) * (1 - smoothstep(L.maxElevation * 0.5, L.maxElevation, e));
        e = lerp(e, -L.depth, lake);
      }
    }

    // Rivers: the zero contour of a warped noise field, carved down to sea level.
    let river = 0, valley = 0;
    const R = P.rivers;
    if (e > -6 && e < R.fadeHigh) {
      const d = Math.abs(this.nRiver.fbm(wx, wz, R.scale, R.octaves, mw));
      if (d < R.valley) {
        const fade = (1 - smoothstep(R.fadeLow, R.fadeHigh, e)) * smoothstep(-6, 3, e);
        valley = (1 - smoothstep(0, R.valley, d)) * fade;
        const floor = R.valleyFloor + 0.04 * e;
        if (e > floor) e = lerp(e, floor, valley * valley * (3 - 2 * valley));
        river = (1 - smoothstep(R.channel * 0.5, R.channel, d)) * fade;
        e = lerp(e, -R.bedDepth, river);
      }
    }

    out.h = e;
    out.cont = c;
    out.mountain = mm;
    out.river = river;
    out.valley = valley;
    out.lake = lake;
    return e;
  }

  /** Moisture 0–1 at a point: wetter in valleys and near lakes, drier in the mountains. */
  moisture(x: number, z: number, s: TerrainSample): number {
    const m = 0.5 + 0.5 * this.nMoist.fbm(x, z, WORLD.biome.moistureScale, 3);
    return Math.min(1, Math.max(0, m + 0.22 * s.valley + 0.2 * s.lake - 0.12 * s.mountain));
  }

  /**
   * Biome, ground colour and tree cover for a point whose height and slope
   * (rise over run) are already known.
   */
  classify(x: number, z: number, h: number, slope: number, s: TerrainSample, out: Surface): void {
    const B = WORLD.biome;
    const tint = 0.9 + 0.12 * this.nTint.get(x / 760, z / 760) + 0.06 * this.nTint.get(x / 95 + 40, z / 95);
    const moisture = this.moisture(x, z, s);
    out.moisture = moisture;
    out.trees = 0;
    out.conifer = 0;

    if (h < -0.25) {
      // Under water: sand shelving into dark depths.
      const deep = smoothstep(-0.5, -16, h);
      const a = BIOME_COLORS[Biome.Shallows], b = BIOME_COLORS[Biome.Ocean];
      out.r = lerp(a[0], b[0], deep);
      out.g = lerp(a[1], b[1], deep);
      out.b = lerp(a[2], b[2], deep);
      out.biome = h < -9 ? Biome.Ocean : Biome.Shallows;
      return;
    }

    const beachTop = B.beachHeight + 1.1 * this.nTint.get(x / 310 + 7, z / 310 - 3);
    const temp = this.nTemp.get(x / B.temperatureScale, z / B.temperatureScale);
    const snowLine = B.snowLine + 90 * temp;

    // Start from grassland, drier and yellower with altitude and low moisture.
    const pl = BIOME_COLORS[Biome.Plains], hl = BIOME_COLORS[Biome.Hills];
    const upland = Math.max(smoothstep(50, 190, h), 1 - smoothstep(0.28, 0.5, moisture));
    let r = lerp(pl[0], hl[0], upland), g = lerp(pl[1], hl[1], upland), b = lerp(pl[2], hl[2], upland);
    let biome: Biome = upland > 0.55 ? Biome.Hills : Biome.Plains;

    // Farmland: patchwork fields on flat, low ground.
    const farm =
      slope < B.farmMaxSlope && h > 3.5 && h < B.farmMaxHeight && moisture < B.forestMoisture + 0.05 &&
      this.nFarm.get(x / B.farmScale, z / B.farmScale) > B.farmThreshold;
    if (farm) {
      const row = Math.floor(z / 210);
      const fx = Math.floor((x + (row & 1) * 85) / 170);
      const hsh = hash2(fx, row, this.seed ^ 0x51ed);
      const crop = CROPS[hsh % CROPS.length];
      const lx = (x + (row & 1) * 85) / 170 - fx, lz = z / 210 - row;
      const edge = Math.min(lx, 1 - lx) * 170 < 3.5 || Math.min(lz, 1 - lz) * 210 < 3.5;
      // Ploughed stripes along one axis of each field.
      const stripe = ((hsh >>> 8) & 1 ? Math.floor(x / 6) : Math.floor(z / 6)) & 1 ? 0.96 : 1.04;
      if (edge) {
        r = 0.25; g = 0.36; b = 0.16;
      } else {
        r = crop[0] * stripe; g = crop[1] * stripe; b = crop[2] * stripe;
      }
      biome = Biome.Farmland;
    }

    // Forest.
    let forest = 0;
    if (!farm) {
      forest =
        smoothstep(B.forestMoisture - 0.06, B.forestMoisture + 0.08, moisture) *
        (1 - smoothstep(B.forestMaxSlope * 0.8, B.forestMaxSlope * 1.25, slope)) *
        (1 - smoothstep(B.forestMaxHeight - 90, B.forestMaxHeight, h)) *
        smoothstep(beachTop + 0.5, beachTop + 4, h);
      if (forest > 0.01) {
        const f = BIOME_COLORS[Biome.Forest];
        r = lerp(r, f[0], forest * 0.9); g = lerp(g, f[1], forest * 0.9); b = lerp(b, f[2], forest * 0.9);
        if (forest > 0.5) biome = Biome.Forest;
      }
    }

    // Bare rock on steep ground and high up.
    const rock = Math.max(smoothstep(B.rockSlope * 0.72, B.rockSlope * 1.25, slope), 0.85 * smoothstep(B.rockLine, B.rockLine + 170, h));
    if (rock > 0.01) {
      const k = BIOME_COLORS[Biome.Rock];
      const shade = 0.85 + 0.3 * this.nTint.get(x / 140 - 11, z / 140 + 5);
      r = lerp(r, k[0] * shade, rock); g = lerp(g, k[1] * shade, rock); b = lerp(b, k[2] * shade, rock);
      if (rock > 0.5) biome = Biome.Rock;
    }

    // Snow above the snow line, except on the steepest faces.
    const snow = smoothstep(snowLine - B.snowBlend, snowLine + B.snowBlend * 0.3, h) * (1 - smoothstep(0.85, 1.4, slope));
    if (snow > 0.01) {
      const k = BIOME_COLORS[Biome.Snow];
      r = lerp(r, k[0], snow); g = lerp(g, k[1], snow); b = lerp(b, k[2], snow);
      if (snow > 0.5) biome = Biome.Snow;
    }

    // Beaches along any shore.
    if (h < beachTop && slope < 0.3) {
      const k = BIOME_COLORS[Biome.Beach];
      const t = 1 - smoothstep(beachTop - 0.8, beachTop, h);
      r = lerp(r, k[0], t); g = lerp(g, k[1], t); b = lerp(b, k[2], t);
      if (t > 0.5) biome = Biome.Beach;
      forest *= 1 - t;
    }

    out.r = r * tint;
    out.g = g * tint;
    out.b = b * tint;
    out.biome = biome;
    out.trees = forest * (1 - rock) * (1 - snow);
    if (biome === Biome.Plains || biome === Biome.Hills) out.trees = Math.max(out.trees, 0.035 * (1 - rock));
    out.conifer = smoothstep(120, 300, h + 140 * temp);
  }
}
