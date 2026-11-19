import { describe, expect, it } from 'vitest';
import { DAY_CYCLE, WEATHER } from '../../src/data/weather';
import { WeatherSystem } from '../../src/game/weather';
import { buildMapTile } from '../../src/world/meshgen';
import { seedFromString } from '../../src/world/rng';
import { World } from '../../src/world/world';

const world = new World(seedFromString('weather'));

/** Find a point near the origin matching a predicate on (height, build density). */
function find(pred: (h: number, dens: number, x: number, z: number) => boolean): { x: number; z: number } {
  for (let r = 0; r < 40000; r += 250) {
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (pred(world.height(x, z), world.density(x, z), x, z)) return { x, z };
    }
  }
  throw new Error('no such point');
}

describe('weather', () => {
  it('is deterministic for a seed: the same sequence of presets, wind and lightning', () => {
    const run = (seed: number) => {
      const w = new WeatherSystem(seed, 'auto', 10);
      const out: string[] = [];
      for (let i = 0; i < 4000; i++) {
        w.update(0.5, world, 0, 0, 100);
        if (i % 200 === 0) out.push(`${w.target}:${w.windSpeed.toFixed(3)}:${w.windDir.toFixed(3)}`);
      }
      return out.join('|');
    };
    expect(run(7)).toBe(run(7));
    expect(run(7)).not.toBe(run(8));
  });

  it('cycles through presets in auto mode and blends between them', () => {
    const w = new WeatherSystem(3, 'auto', 10);
    const seen = new Set<string>([w.target]);
    let prevCover = w.cur.cover, maxStep = 0;
    for (let t = 0; t < 4 * 3600; t += 1) {
      w.update(1, world, 0, 0, 100);
      seen.add(w.target);
      maxStep = Math.max(maxStep, Math.abs(w.cur.cover - prevCover));
      prevCover = w.cur.cover;
    }
    expect(seen.size).toBeGreaterThanOrEqual(7);
    // Blends and swells are gradual: cover never jumps by more than a few percent in a second.
    expect(maxStep).toBeLessThan(0.045);
  });

  it('changes often in auto mode: several spells an hour', () => {
    const w = new WeatherSystem(4, 'auto', 10);
    let changes = 0, last = w.target;
    for (let t = 0; t < 3600; t += 1) {
      w.update(1, world, 0, 0, 100);
      if (w.target !== last) (changes++, (last = w.target));
    }
    expect(changes).toBeGreaterThanOrEqual(14);
  });

  it('a fixed preset stays put, with its wind and precipitation, but swells within it', () => {
    const w = new WeatherSystem(5, 'storm', 14);
    let lo = 1, hi = 0;
    for (let i = 0; i < 600; i++) {
      w.update(1, world, 0, 0, 100);
      lo = Math.min(lo, w.cur.precip);
      hi = Math.max(hi, w.cur.precip);
    }
    expect(w.target).toBe('storm');
    expect(lo).toBeGreaterThan(0.2);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi - lo).toBeGreaterThan(0.1);
    expect(w.windSpeed).toBeGreaterThanOrEqual(WEATHER.storm.wind[0] - 0.5);
    expect(w.windSpeed).toBeLessThanOrEqual(WEATHER.storm.wind[1] + 0.5);
  });

  it('storms make lightning; clear skies do not', () => {
    const strikes = (mode: string) => {
      const w = new WeatherSystem(9, mode, 14);
      let n = 0;
      w.onStrike = () => n++;
      for (let i = 0; i < 1200; i++) w.update(0.5, world, 0, 0, 100);
      return n;
    };
    expect(strikes('storm')).toBeGreaterThan(20);
    expect(strikes('clear')).toBe(0);
  });

  it('the clock runs secondsPerHour by day and nightSpeed times faster at night', () => {
    const hourTakes = (from: number) => {
      const w = new WeatherSystem(1, 'clear', from);
      let t = 0;
      while (w.hour < from + 1) (w.update(0.1, world, 0, 0, 100), (t += 0.1));
      return t;
    };
    expect(hourTakes(12)).toBeCloseTo(DAY_CYCLE.secondsPerHour, 0);
    expect(hourTakes(1)).toBeCloseTo(DAY_CYCLE.secondsPerHour / DAY_CYCLE.nightSpeed, 0);
  });
});

describe('turbulence varies by area', () => {
  const w = new WeatherSystem(11, 'overcast', 12);
  w.windSpeed = 10;
  const water = find((h, _d, x, z) => h < -20 && world.height(x + 400, z) < -20 && world.height(x - 400, z) < -20 && world.height(x, z + 400) < -20);
  const city = find((_h, d) => d > 0.85);
  const plains = find((h, d, x, z) => h > 5 && h < 80 && d === 0 && Math.abs(world.height(x + 300, z) - h) < 4 && Math.abs(world.height(x, z + 300) - h) < 4 && Math.abs(world.height(x - 300, z) - h) < 4);
  const mountains = find((h) => h > 600);
  const at = (p: { x: number; z: number }, agl = 30) => w.turbulenceAt(world, p.x, p.z, agl);

  it('is rough over mountains and cities, smooth over plains and water', () => {
    expect(at(mountains)).toBeGreaterThan(at(plains) * 3);
    expect(at(city)).toBeGreaterThan(at(plains) * 2);
    expect(at(water)).toBeLessThan(at(plains) + 0.05);
    expect(at(mountains)).toBeGreaterThan(1.2);
  });

  it('fades with height above the ground and scales with the wind', () => {
    expect(at(mountains, 600)).toBeLessThan(at(mountains, 30) * 0.2);
    const strong = at(city);
    w.windSpeed = 2;
    expect(at(city)).toBeLessThan(strong * 0.4);
    w.windSpeed = 10;
  });

  it('includes daytime thermals over land, not at night', () => {
    const day = new WeatherSystem(1, 'clear', 13);
    day.windSpeed = 0;
    const night = new WeatherSystem(1, 'clear', 1);
    night.windSpeed = 0;
    expect(day.turbulenceAt(world, plains.x, plains.z, 300)).toBeGreaterThan(0.3);
    expect(night.turbulenceAt(world, plains.x, plains.z, 300)).toBe(0);
  });
});

describe('minimap tiles', () => {
  it('are deterministic and show both water and land', () => {
    const p = find((h, _d, x, z) => h > 3 && (world.height(x + 1500, z) < -2 || world.height(x - 1500, z) < -2 || world.height(x, z + 1500) < -2));
    const a = buildMapTile(world, p.x - 2048, p.z - 2048, 4096, 64);
    const b = buildMapTile(new World(world.seed), p.x - 2048, p.z - 2048, 4096, 64);
    expect(Array.from(a)).toEqual(Array.from(b));
    let blue = 0, green = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i + 2] > a[i] + 30 && a[i + 2] > a[i + 1]) blue++;
      else if (a[i + 1] >= a[i + 2]) green++;
      expect(a[i + 3]).toBe(255);
    }
    expect(blue).toBeGreaterThan(50);
    expect(green).toBeGreaterThan(50);
  });
});

describe('weather from untrusted input', () => {
  it('ignores names inherited from Object (?weather=toString)', () => {
    for (const bad of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      const w = new WeatherSystem(7, bad, -1);
      expect(w.mode).toBe('auto');
      expect(Number.isFinite(w.cur.cover)).toBe(true);
      w.setMode(bad, true);
      expect(w.mode).toBe('auto');
    }
  });
});
