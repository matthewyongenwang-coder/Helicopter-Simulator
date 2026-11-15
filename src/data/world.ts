/**
 * World generation parameters. Distances in metres. Sea level is y = 0.
 * Everything the terrain, biome and (later) settlement generators need lives here.
 */
export const WORLD = {
  /** Shortest terrain wavelength, m. Physics samples the analytic height, so keep this ≥ 40. */
  minWavelength: 48,

  warp: { scale: 5200, amount: 950 },

  continent: {
    scale: 15000,
    octaves: 4,
    /** Added to the continental noise: higher = more land. */
    landBias: 0.1,
    /** Height at continental value 1 (land) and depth at −1 (sea), with their curve exponents. */
    landRise: 250,
    landExponent: 1.45,
    seaDepth: 210,
    seaExponent: 1.2,
  },

  hills: {
    scale: 2900,
    octaves: 4,
    amplitude: 42,
    /** Extra amplitude where the hilliness field is high. */
    amplitudeVar: 75,
    varScale: 11000,
  },

  mountains: {
    maskScale: 24000,
    /** Mask threshold range on (mask noise + 0.35 × continentalness). */
    maskLow: 0.22,
    maskHigh: 0.55,
    scale: 6200,
    octaves: 5,
    height: 1150,
    base: 130,
  },

  detail: {
    scale: 430,
    octaves: 3,
    amplitude: 4.5,
    mountainAmplitude: 15,
    microScale: 62,
    microAmplitude: 0.45,
  },

  rivers: {
    scale: 8600,
    octaves: 2,
    /** Half-widths in noise units: the water channel and the valley around it. */
    channel: 0.0125,
    valley: 0.09,
    bedDepth: 4.2,
    /** Rivers fade out between these base elevations (they do not climb mountains). */
    fadeLow: 150,
    fadeHigh: 380,
    valleyFloor: 1.6,
  },

  lakes: {
    scale: 5400,
    low: 0.5,
    high: 0.66,
    depth: 7,
    /** Lakes only form below this base elevation. */
    maxElevation: 150,
  },

  biome: {
    moistureScale: 5200,
    temperatureScale: 9000,
    beachHeight: 2.4,
    snowLine: 560,
    snowBlend: 110,
    rockSlope: 0.62, // slope (rise/run) where rock shows through
    rockLine: 400,
    forestMoisture: 0.5,
    forestMaxHeight: 440,
    forestMaxSlope: 0.5,
    farmScale: 2600,
    farmThreshold: 0.22,
    farmMaxSlope: 0.07,
    farmMaxHeight: 110,
  },
} as const;

export type WorldParams = typeof WORLD;

/** Biome ids. Kept small and stable: they are written into chunk data. */
export const enum Biome {
  Ocean = 0,
  Shallows = 1,
  Beach = 2,
  Plains = 3,
  Forest = 4,
  Hills = 5,
  Rock = 6,
  Snow = 7,
  Farmland = 8,
  Urban = 9,
}

export const BIOME_NAMES = ['Ocean', 'Shallows', 'Beach', 'Plains', 'Forest', 'Hills', 'Mountain', 'Snow', 'Farmland', 'Urban'];

/** Base colours per biome, linear-ish sRGB 0–1. Vertex colours are blended from these. */
export const BIOME_COLORS: [number, number, number][] = [
  [0.1, 0.17, 0.2], // ocean floor
  [0.42, 0.44, 0.33], // shallows
  [0.76, 0.7, 0.52], // beach
  [0.36, 0.5, 0.2], // plains
  [0.16, 0.31, 0.13], // forest floor
  [0.45, 0.47, 0.25], // hills
  [0.42, 0.4, 0.38], // rock
  [0.93, 0.95, 0.98], // snow
  [0.55, 0.52, 0.24], // farmland
  [0.42, 0.42, 0.41], // urban
];
