/**
 * Weather presets and the area-turbulence model. Speeds in m/s, heights in metres.
 * The weather system blends between presets; nothing here is logic.
 */

export type PrecipType = 'none' | 'rain' | 'snow';

export interface WeatherPreset {
  label: string;
  /** Sky flattening toward grey, 0–1. */
  overcast: number;
  /** Cloud cover of the cloud layer, 0–1. */
  cover: number;
  /** Cloud layer base above sea level. */
  cloudBase: number;
  /** Fog density multiplier (1 = clear-day haze). */
  haze: number;
  /** Mean wind speed range; the direction drifts slowly. */
  wind: [number, number];
  /** Gust strength, m/s. */
  gust: number;
  /** Precipitation rate 0–1. */
  precip: number;
  precipType: PrecipType;
  /** Mean seconds between lightning strikes (0 = none). */
  lightning: number;
  /** Water chop multiplier. */
  chop: number;
  /** How likely the automatic cycle picks this preset. */
  weight: number;
  /** How strongly cover, rain and gusts swell and ease while it lasts, 0–1. */
  swing: number;
}

export const WEATHER: Record<string, WeatherPreset> = {
  clear: { label: 'Clear', overcast: 0, cover: 0.12, cloudBase: 1700, haze: 0.85, wind: [1, 4], gust: 0.4, precip: 0, precipType: 'none', lightning: 0, chop: 0.75, weight: 3, swing: 0.25 },
  fair: { label: 'Fair', overcast: 0.08, cover: 0.42, cloudBase: 1300, haze: 1, wind: [3, 7], gust: 1.2, precip: 0, precipType: 'none', lightning: 0, chop: 1, weight: 4, swing: 0.4 },
  gale: { label: 'Gale', overcast: 0.25, cover: 0.55, cloudBase: 1100, haze: 1.2, wind: [13, 20], gust: 5, precip: 0, precipType: 'none', lightning: 0, chop: 2.3, weight: 1, swing: 0.6 },
  mist: { label: 'Mist', overcast: 0.4, cover: 0.35, cloudBase: 600, haze: 4.5, wind: [0, 3], gust: 0.4, precip: 0, precipType: 'none', lightning: 0, chop: 0.6, weight: 1.5, swing: 0.5 },
  overcast: { label: 'Overcast', overcast: 0.75, cover: 0.86, cloudBase: 900, haze: 1.5, wind: [5, 10], gust: 2, precip: 0, precipType: 'none', lightning: 0, chop: 1.25, weight: 2, swing: 0.35 },
  showers: { label: 'Showers', overcast: 0.55, cover: 0.72, cloudBase: 800, haze: 1.7, wind: [4, 10], gust: 2.6, precip: 0.5, precipType: 'rain', lightning: 0, chop: 1.3, weight: 2.5, swing: 1 },
  rain: { label: 'Rain', overcast: 0.9, cover: 0.95, cloudBase: 650, haze: 2.4, wind: [6, 12], gust: 3, precip: 0.7, precipType: 'rain', lightning: 0, chop: 1.5, weight: 2, swing: 0.5 },
  storm: { label: 'Storm', overcast: 1, cover: 1, cloudBase: 550, haze: 3.2, wind: [11, 18], gust: 6, precip: 1, precipType: 'rain', lightning: 9, chop: 2.1, weight: 1.3, swing: 0.6 },
  fog: { label: 'Fog', overcast: 0.65, cover: 0.5, cloudBase: 400, haze: 9, wind: [0, 2], gust: 0.3, precip: 0, precipType: 'none', lightning: 0, chop: 0.5, weight: 1, swing: 0.45 },
  snow: { label: 'Snow', overcast: 0.85, cover: 0.92, cloudBase: 700, haze: 3.6, wind: [3, 8], gust: 2.2, precip: 0.75, precipType: 'snow', lightning: 0, chop: 1.1, weight: 1.2, swing: 0.6 },
};

export const WEATHER_ORDER = ['clear', 'fair', 'gale', 'mist', 'overcast', 'showers', 'rain', 'storm', 'fog', 'snow'];

export const WEATHER_CYCLE = {
  /** In 'auto' mode a preset lasts this long before a new one is drawn, s. */
  holdMin: 70,
  holdMax: 200,
  /** Seconds to blend from one preset to the next. */
  blend: 40,
  /**
   * Each time a preset comes round it is drawn a little differently: cover,
   * cloud base, haze, gusts and rain are scaled by up to ± this fraction.
   */
  jitter: 0.3,
  /** Within a preset, how far cover, haze, rain and gusts swell and ease at full swing (fraction). */
  swell: 0.45,
  /** Period range of those swells, s. */
  swellPeriod: [40, 120] as [number, number],
  /** Wind direction wanders at about this rate, rad/s. */
  veer: 0.004,
};

export const DAY_CYCLE = {
  /** Real seconds per daylight game hour. */
  secondsPerHour: 40,
  /** Night hours pass this many times faster, so the dark stretch is short. */
  nightSpeed: 2.5,
  /** Starting hour when the menu leaves it on automatic. */
  defaultHour: 9.5,
};

/**
 * Turbulence that varies by area, added to the weather's gusts (m/s).
 * The aircraft feels it near rough ground and buildings, scaled by wind.
 */
export const AREA_TURBULENCE = {
  /** Height over which the ground's influence fades out, m. */
  depth: 220,
  /** Terrain relief (height range across a 600 m box) that counts as fully rough, m. */
  roughRelief: 260,
  /** Mechanical turbulence over rough ground per m/s of wind. */
  roughPerWind: 0.32,
  /** Over a dense city per m/s of wind (building wakes). */
  urbanPerWind: 0.26,
  /** Daytime thermals over land, scaled by sun height. */
  thermal: 0.9,
  /** Calm over water. */
  waterFactor: 0.45,
};
