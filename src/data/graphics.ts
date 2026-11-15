/** Graphics quality presets. Distances in metres. */
export interface GraphicsPreset {
  label: string;
  /** Cells per side of a terrain node. Finest ground spacing is 256 / cells metres. */
  terrainCells: number;
  /** A node splits when the camera is closer than its size × this. */
  splitFactor: number;
  /** Fog reaches the sky colour at about this distance. */
  viewDistance: number;
  /** Cap on device pixel ratio. */
  pixelRatio: number;
  antialias: boolean;
  shadows: boolean;
  shadowMapSize: number;
  /** Prop view radii and density scale (milestone 3). */
  treeRadius: number;
  treeDensity: number;
  buildingRadius: number;
  detailRadius: number;
  /** Water wave octaves and cloud detail. */
  waterDetail: number;
  clouds: boolean;
  workers: number;
}

export const GRAPHICS: Record<'low' | 'medium' | 'high', GraphicsPreset> = {
  low: {
    label: 'Low',
    terrainCells: 32,
    splitFactor: 1.5,
    viewDistance: 12000,
    pixelRatio: 1,
    antialias: false,
    shadows: false,
    shadowMapSize: 1024,
    treeRadius: 700,
    treeDensity: 0.45,
    buildingRadius: 4500,
    detailRadius: 600,
    waterDetail: 3,
    clouds: false,
    workers: 2,
  },
  medium: {
    label: 'Medium',
    terrainCells: 48,
    splitFactor: 1.75,
    viewDistance: 18000,
    pixelRatio: 1.5,
    antialias: true,
    shadows: true,
    shadowMapSize: 2048,
    treeRadius: 1100,
    treeDensity: 0.75,
    buildingRadius: 7000,
    detailRadius: 900,
    waterDetail: 5,
    clouds: true,
    workers: 4,
  },
  high: {
    label: 'High',
    terrainCells: 64,
    splitFactor: 2.0,
    viewDistance: 24000,
    pixelRatio: 2,
    antialias: true,
    shadows: true,
    shadowMapSize: 4096,
    treeRadius: 1500,
    treeDensity: 1,
    buildingRadius: 9500,
    detailRadius: 1200,
    waterDetail: 6,
    clouds: true,
    workers: 6,
  },
};

export type QualityName = keyof typeof GRAPHICS;

export const TERRAIN_LOD = {
  /** Size of the finest node, m. */
  leafSize: 256,
  /** Levels above the leaf. Root size = leafSize × 2^levels. */
  levels: 6,
  /** A split node merges back only beyond splitFactor × this, to stop flicker. */
  mergeHysteresis: 1.15,
  /** Floating origin: re-centre when the camera is this far from the scene origin. */
  rebaseDistance: 1536,
  rebaseSnap: 512,
};
