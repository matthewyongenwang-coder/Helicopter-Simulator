import { AREA_TURBULENCE as AT, DAY_CYCLE, WEATHER, WEATHER_CYCLE, WEATHER_ORDER, type WeatherPreset } from '../data/weather';
import { rng } from '../world/rng';
import type { World } from '../world/world';

/** The numeric part of a preset, which is what gets blended. */
interface Mix {
  overcast: number;
  cover: number;
  cloudBase: number;
  haze: number;
  windTarget: number;
  gust: number;
  precip: number;
  snow: number;
  lightning: number;
  chop: number;
}

interface GroundRoughness {
  relief: number;
  urban: number;
  water: number;
}

function mixOf(p: WeatherPreset, r: () => number): Mix {
  return {
    overcast: p.overcast,
    cover: p.cover,
    cloudBase: p.cloudBase,
    haze: p.haze,
    windTarget: p.wind[0] + (p.wind[1] - p.wind[0]) * r(),
    gust: p.gust,
    precip: p.precip,
    snow: p.precipType === 'snow' ? 1 : 0,
    lightning: p.lightning,
    chop: p.chop,
  };
}

const PROBES = [[0, 0], [-300, 0], [300, 0], [0, -300], [0, 300], [-210, -210], [210, 210], [-210, 210], [210, -210]];

/**
 * Time of day, weather, wind and turbulence. Owns no rendering: the game reads
 * the blended state and hands it to the sky, clouds, water, effects, audio and
 * the flight model's environment.
 */
export class WeatherSystem {
  /** 'auto' cycles through presets; otherwise a preset id that stays put. */
  mode: string;
  /** Hours, 0–24. */
  hour: number;
  /** Whether the clock runs. */
  clock = true;
  readonly cur: Mix;
  private from: Mix;
  private to: Mix;
  private blend = 1;
  private hold: number;
  /** The preset being blended toward. */
  target: string;
  /** Mean wind speed, m/s, and the direction the air moves toward (rad from +X toward +Z). */
  windSpeed = 0;
  windDir: number;
  /** Lightning flash brightness, decays quickly. */
  flash = 0;
  private nextStrike = 20;
  private r: () => number;
  /** Fired on a lightning strike with its distance (m), for thunder. */
  onStrike: ((distance: number) => void) | null = null;
  /** Turbulence from the area under the aircraft, m/s. */
  areaTurbulence = 0;
  private turbCache = new Map<number, GroundRoughness>();

  constructor(seed: number, mode = 'auto', hour = -1) {
    this.r = rng(seed ^ 0x5eed);
    this.mode = mode in WEATHER ? mode : 'auto';
    this.hour = hour >= 0 ? hour : DAY_CYCLE.defaultHour;
    this.target = this.mode === 'auto' ? 'fair' : this.mode;
    this.cur = mixOf(WEATHER[this.target], this.r);
    this.from = { ...this.cur };
    this.to = { ...this.cur };
    this.hold = this.holdTime();
    this.windDir = this.r() * Math.PI * 2;
    this.windSpeed = this.cur.windTarget;
  }

  get label(): string {
    return WEATHER[this.target].label;
  }

  /** Snow (true) or rain (false) for whatever is falling. */
  get snowing(): boolean {
    return this.cur.snow > 0.5;
  }

  get windX(): number {
    return Math.cos(this.windDir) * this.windSpeed;
  }

  get windZ(): number {
    return Math.sin(this.windDir) * this.windSpeed;
  }

  private holdTime(): number {
    return WEATHER_CYCLE.holdMin + (WEATHER_CYCLE.holdMax - WEATHER_CYCLE.holdMin) * this.r();
  }

  /** Weighted draw of the next preset, never the same one twice running. */
  private pick(): string {
    const ids = WEATHER_ORDER.filter((id) => id !== this.target);
    const total = ids.reduce((s, id) => s + WEATHER[id].weight, 0);
    let x = this.r() * total;
    for (const id of ids) if ((x -= WEATHER[id].weight) <= 0) return id;
    return ids[0];
  }

  /** Choose a preset (or 'auto'). `now` skips the blend. */
  setMode(mode: string, now = true): void {
    this.mode = mode in WEATHER ? mode : 'auto';
    if (this.mode !== 'auto') this.goTo(this.mode, now);
  }

  private goTo(id: string, now: boolean): void {
    this.target = id;
    this.from = { ...this.cur };
    this.to = mixOf(WEATHER[id], this.r);
    this.blend = now ? 1 : 0;
    if (now) {
      Object.assign(this.cur, this.to);
      this.windSpeed = this.to.windTarget;
    }
    this.hold = this.holdTime();
  }

  /** Advance the clock and the weather, and work out turbulence at the aircraft. */
  update(dt: number, world: World, x: number, z: number, agl: number): void {
    if (this.clock) this.hour = (this.hour + dt / DAY_CYCLE.secondsPerHour) % 24;

    // Weather blend and the automatic cycle.
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / WEATHER_CYCLE.blend);
      const k = this.blend * this.blend * (3 - 2 * this.blend);
      for (const key of Object.keys(this.cur) as (keyof Mix)[]) this.cur[key] = this.from[key] + (this.to[key] - this.from[key]) * k;
    } else if (this.mode === 'auto' && (this.hold -= dt) <= 0) {
      this.goTo(this.pick(), false);
    }

    // Wind: speed eases toward the preset's, direction wanders.
    this.windSpeed += (this.cur.windTarget - this.windSpeed) * Math.min(1, dt * 0.05);
    this.windDir += (this.r() - 0.5) * 16 * WEATHER_CYCLE.veer * dt;

    // Lightning.
    this.flash = Math.max(0, this.flash - dt * 6);
    if (this.cur.lightning > 0 && this.cur.precip > 0.5) {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        const dist = 700 + this.r() * 7500;
        this.flash = Math.min(1.6, 0.4 + 6000 / (dist + 1500));
        this.nextStrike = -Math.log(1 - this.r() * 0.98) * this.cur.lightning + 1.5;
        this.onStrike?.(dist);
      }
    }

    this.areaTurbulence = this.turbulenceAt(world, x, z, agl);
  }

  /** Sun height factor 0–1 for thermals, from the clock. */
  private sunFactor(): number {
    return Math.max(0, Math.sin((Math.PI * (this.hour - 6)) / 12));
  }

  private roughness(world: World, x: number, z: number): GroundRoughness {
    const cell = 300;
    const ci = Math.floor(x / cell), cj = Math.floor(z / cell);
    const key = (ci + 33554432) * 67108864 + (cj + 33554432);
    let g = this.turbCache.get(key);
    if (!g) {
      if (this.turbCache.size > 4000) this.turbCache.clear();
      const cx = (ci + 0.5) * cell, cz = (cj + 0.5) * cell;
      let lo = Infinity, hi = -Infinity, water = 0;
      for (const [dx, dz] of PROBES) {
        const h = world.height(cx + dx, cz + dz);
        lo = Math.min(lo, Math.max(h, 0));
        hi = Math.max(hi, h);
        if (h < 0) water++;
      }
      g = { relief: Math.min(1, (hi - lo) / AT.roughRelief), urban: world.density(cx, cz), water: water / PROBES.length };
      this.turbCache.set(key, g);
    }
    return g;
  }

  /**
   * Turbulence that varies by area: mechanical turbulence over rough ground and
   * city blocks (scaled by wind), thermals over sunny land, calmer air over
   * water. It fades with height above the ground.
   */
  turbulenceAt(world: World, x: number, z: number, agl: number): number {
    const g = this.roughness(world, x, z);
    const fade = Math.exp(-Math.max(0, agl) / AT.depth);
    const mech = (AT.roughPerWind * g.relief + AT.urbanPerWind * g.urban) * this.windSpeed * fade;
    const thermalHeight = Math.min(1, Math.max(0, agl) / 120) * Math.exp(-Math.max(0, agl - 900) / 600);
    const thermal = AT.thermal * this.sunFactor() * (1 - this.cur.overcast) * thermalHeight * (1 - g.water);
    return (mech + thermal) * (1 - g.water * (1 - AT.waterFactor));
  }
}
