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
    landBias: 0.16,
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

/** Settlement placement and layout. */
export const SETTLEMENTS = {
  /** One candidate site per cell of this size, m. */
  cellSize: 6000,
  /** One city per block of this many cells squared. */
  cityEvery: 3,
  /** Cells per city block that are earmarked for a town. */
  townsPerCity: 2,
  /** Chance that a non-city cell holds a town / village / hamlet (the rest stay empty). */
  townChance: 0.22,
  villageChance: 0.32,
  hamletChance: 0.22,
  /** Radius range per kind, m: hamlet, village, town, city. */
  radius: [
    [130, 180],
    [270, 370],
    [560, 760],
    [1350, 1750],
  ],
  /** Site rules: natural elevation range and how much the ground may vary across the site. */
  minElevation: 5,
  maxElevation: 150,
  maxRelief: 0.07, // rise over run across half the radius
  maxMountain: 0.12,
  /** Ground is levelled fully inside this fraction of the radius, blending out by `flattenOuter`. */
  flattenInner: 0.6,
  flattenOuter: 1.2,
  /** Fraction of the natural relief left in the levelled core, so towns are not billiard tables. */
  flattenResidual: 0.06,
  /** Street grid: block size along and across, by kind. Street half-width, m. */
  block: [
    [64, 64],
    [72, 64],
    [92, 70],
    [100, 76],
  ],
  streetHalfWidth: 4.5,
  avenueHalfWidth: 7.5,
  avenueEvery: 4,
  /** Density (0–1) above which blocks are built, and where mid-rise and towers begin. */
  buildDensity: 0.1,
  midriseDensity: 0.42,
  towerDensity: 0.72,
  maxTowerHeight: 230,
  /** Fraction of suitable flat roofs that carry a helipad. */
  rooftopPadChance: 0.05,
  lightSpacing: 46,
} as const;

export const ROADS = {
  /** Sample spacing along a road, m. */
  spacing: 24,
  /** Sideways wander as a fraction of road length, capped in metres. */
  wander: 0.11,
  maxWander: 650,
  /** Chance of a road between orthogonal / diagonal neighbouring settlements. */
  orthogonalChance: 0.9,
  diagonalChance: 0.3,
  rural: { halfWidth: 4.2 },
  highway: { halfWidth: 8.5 },
  /** Roads are dropped if they would need a single bridge longer than this, m. */
  maxBridge: 950,
  maxWaterFraction: 0.4,
  maxElevation: 430,
  /** Deck height over water and the smoothing window for the road profile (samples each side). */
  deckHeight: 9,
  minDeck: 6.5,
  /** Steepest road grade (rise over run). Steeper ground is bridged by fill. */
  maxGrade: 0.12,
  smooth: 5,
  /** Terrain blends from road level back to natural over this distance past the shoulder, m. */
  shoulder: 2.5,
  blend: 26,
  /** Bridges longer than this get towers and cables. */
  towerSpan: 240,
  pierSpacing: 56,
} as const;

export const PROPS = {
  /** Structure cells: buildings, roads, bridges, pylons, turbines, boats. */
  structureCell: 1024,
  /** Forest cells: individual trees close to the camera. */
  forestCell: 256,
  treeSpacing: 10.5,
  farTreeSpacing: 34,
  farTreeRadius: 3600,
  /** Power lines: pylon spacing and offset from the road they follow, m. */
  pylonSpacing: 260,
  pylonOffset: 70,
  pylonHeight: 34,
  powerLineChance: 0.5,
  /** Wind farms: chance per structure cell, and the elevation band they like. */
  windFarmChance: 0.035,
  turbineHeight: 80,
  /** Boats per structure cell near a harbour, and the chance of a lone boat elsewhere. */
  harbourBoats: 4,
  loneBoatChance: 0.05,
} as const;

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
