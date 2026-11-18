/**
 * How each aircraft looks and sounds. Geometry is described as a lofted fuselage
 * (cross-sections along the nose–tail axis) plus a handful of parts, all in body
 * axes: +X right, +Y up, −Z forward, origin at the centre of gravity, metres.
 */

/** Fuselage cross-section: [z, half-width, half-height, centre y, squareness (2 = ellipse, 6 = boxy)]. */
export type Station = [number, number, number, number, number];
/** Ellipsoid: [x, y, z, rx, ry, rz]. */
export type Blob = [number, number, number, number, number, number];
/** Box: [x, y, z, sx, sy, sz, pitch (rad, optional)]. */
export type Slab = [number, number, number, number, number, number, number?];

export interface AircraftVisual {
  paint: number;
  accent: number;
  /** Accent band: fuselage stations between these z values take the accent colour. */
  band?: [number, number];
  glass: number;
  fuselage: Station[];
  /** Tail boom from [z0, y0, r0] to [z1, y1, r1]. */
  boom: [number, number, number, number, number, number];
  /** Vertical fin: base z, base y, height, chord, sweep (m of lean aft). */
  fin: [number, number, number, number, number];
  /** Horizontal stabiliser: z, y, span, chord. */
  stabiliser: [number, number, number, number];
  /** Tail rotor: side (−1 left, +1 right), radius, blades, y above the boom end. */
  tailRotor: [number, number, number, number];
  glassParts: Blob[];
  pods: Blob[];
  /** Extra painted boxes: stub wings, sponsons, fairings. */
  slabs: Slab[];
  /** Dark boxes: exhausts, guns, sensors. */
  darkSlabs: Slab[];
  /** Mast top is at the hub; this is where it leaves the fuselage. */
  mastBase: number;
  /** Blade droop at rest, radians. */
  droop: number;
  /** Stabiliser bar across the hub (two-bladed teetering rotors). */
  flybar?: boolean;
  /** Pilot eye point for the cockpit camera. */
  eye: [number, number, number];
  /** Cockpit frame: glareshield top y, pillar half-spacing, panel depth ahead of the eye. */
  cockpit: { shield: number; pillar: number; reach: number; roof: number };
  wheelRadius: number;
  audio: {
    /** Turbine whine at 100 % in Hz, and how loud it is relative to the rotor. */
    turbineHz: number;
    turbineGain: number;
    /** Gearbox/engine rumble fundamental, Hz. */
    rumbleHz: number;
    /** Blade thump character: 0 soft swish … 1 hard slap. */
    slap: number;
    /** Overall level. */
    gain: number;
  };
}

export const AIRCRAFT_VISUAL: Record<string, AircraftVisual> = {
  scout: {
    paint: 0xb3261e,
    accent: 0xf2efe8,
    band: [-0.2, 1.6],
    glass: 0x16303b,
    fuselage: [
      [-2.25, 0.1, 0.14, -0.3, 2],
      [-2.0, 0.42, 0.48, -0.22, 2.2],
      [-1.3, 0.7, 0.82, -0.05, 2.4],
      [-0.4, 0.74, 0.92, 0.05, 2.6],
      [0.5, 0.62, 0.8, 0.12, 2.6],
      [1.15, 0.34, 0.46, 0.28, 2.2],
      [1.6, 0.14, 0.18, 0.36, 2],
    ],
    boom: [1.3, 0.36, 0.15, 4.75, 0.5, 0.07],
    fin: [4.35, 0.5, 1.15, 0.55, 0.35],
    stabiliser: [4.55, 1.55, 1.5, 0.34],
    tailRotor: [-1, 0.72, 2, 0.1],
    glassParts: [[0, 0.05, -1.25, 0.69, 0.78, 1.0]],
    pods: [[0, 0.95, 0.35, 0.3, 0.26, 0.75]],
    // Weapon pylons across the cabin floor.
    slabs: [[0, -0.45, -0.45, 2.9, 0.08, 0.42]],
    darkSlabs: [
      [0, 0.95, 1.15, 0.2, 0.2, 0.3],
      // Gun pods under the pylons.
      [-1.05, -0.62, -0.55, 0.2, 0.2, 1.45],
      [1.05, -0.62, -0.55, 0.2, 0.2, 1.45],
    ],
    mastBase: 1.0,
    droop: 0.05,
    eye: [-0.3, 0.32, -0.95],
    cockpit: { shield: -0.02, pillar: 0.62, reach: 0.75, roof: 0.78 },
    wheelRadius: 0,
    audio: { turbineHz: 5200, turbineGain: 0.5, rumbleHz: 92, slap: 0.25, gain: 0.8 },
  },

  utility: {
    paint: 0x4b5a3a,
    accent: 0x3b4830,
    glass: 0x1a2a30,
    fuselage: [
      [-4.2, 0.2, 0.25, -0.5, 2.4],
      [-3.8, 0.75, 0.62, -0.42, 3],
      [-3.0, 1.15, 0.92, -0.2, 3.6],
      [-1.5, 1.28, 1.05, -0.1, 4.5],
      [1.3, 1.28, 1.05, -0.1, 4.5],
      [2.3, 0.95, 0.82, 0.12, 3.2],
      [3.2, 0.42, 0.45, 0.42, 2.4],
    ],
    boom: [2.8, 0.42, 0.36, 8.1, 0.62, 0.14],
    fin: [7.5, 0.6, 2.0, 0.85, 0.75],
    stabiliser: [6.6, 0.62, 2.7, 0.55],
    tailRotor: [-1, 1.3, 2, 1.85],
    glassParts: [
      [0, 0.02, -3.15, 1.02, 0.7, 0.85],
      [0, -0.62, -3.75, 0.62, 0.3, 0.42],
    ],
    pods: [[0, 1.25, 1.2, 0.62, 0.42, 1.5]],
    slabs: [],
    darkSlabs: [[0, 1.3, 2.75, 0.34, 0.34, 0.5]],
    mastBase: 1.25,
    droop: 0.07,
    flybar: true,
    eye: [0.55, 0.3, -2.75],
    cockpit: { shield: -0.05, pillar: 0.98, reach: 0.9, roof: 0.82 },
    wheelRadius: 0,
    audio: { turbineHz: 3900, turbineGain: 0.36, rumbleHz: 64, slap: 1.0, gain: 1.0 },
  },

  medium: {
    paint: 0x2c3230,
    accent: 0x232827,
    glass: 0x121c22,
    fuselage: [
      [-5.6, 0.18, 0.2, -0.75, 2.2],
      [-5.2, 0.7, 0.5, -0.62, 3],
      [-4.3, 1.08, 0.8, -0.4, 3.6],
      [-2.9, 1.18, 0.98, -0.22, 4.2],
      [1.6, 1.18, 0.98, -0.22, 4.2],
      [2.9, 0.92, 0.82, 0.02, 3.4],
      [4.3, 0.4, 0.5, 0.36, 2.6],
    ],
    boom: [3.6, 0.3, 0.44, 9.4, 0.72, 0.2],
    fin: [8.7, 0.6, 2.35, 1.3, 1.05],
    stabiliser: [9.2, 0.75, 4.2, 1.0],
    tailRotor: [1, 1.65, 4, 1.9],
    glassParts: [
      [0, -0.08, -4.45, 0.98, 0.6, 0.95],
      [0, -0.8, -5.0, 0.55, 0.28, 0.4],
    ],
    pods: [
      [-0.72, 1.0, 0.7, 0.42, 0.4, 1.7],
      [0.72, 1.0, 0.7, 0.42, 0.4, 1.7],
      [0, 0.95, -0.9, 0.7, 0.34, 1.3],
      // Nose turret.
      [0, -1.12, -4.75, 0.32, 0.26, 0.32],
    ],
    // Stub wings for the missile rails.
    slabs: [
      [-1.85, -0.5, -0.5, 1.5, 0.12, 1.05],
      [1.85, -0.5, -0.5, 1.5, 0.12, 1.05],
    ],
    darkSlabs: [
      [-0.72, 1.0, 2.35, 0.34, 0.3, 0.4],
      [0.72, 1.0, 2.35, 0.34, 0.3, 0.4],
      [0, -1.22, -5.3, 0.1, 0.1, 1.0],
      [-2.23, -0.62, -0.55, 0.12, 0.14, 0.9],
      [2.23, -0.62, -0.55, 0.12, 0.14, 0.9],
    ],
    mastBase: 1.15,
    droop: 0.06,
    eye: [0.55, 0.12, -3.85],
    cockpit: { shield: -0.2, pillar: 0.96, reach: 0.95, roof: 0.68 },
    wheelRadius: 0.36,
    audio: { turbineHz: 4400, turbineGain: 0.42, rumbleHz: 70, slap: 0.55, gain: 1.0 },
  },

  heavy: {
    paint: 0x6c7479,
    accent: 0x5c6468,
    glass: 0x141d24,
    fuselage: [
      [-9.4, 0.25, 0.3, -1.05, 2.4],
      [-8.9, 0.95, 0.75, -0.9, 3],
      [-7.6, 1.5, 1.2, -0.55, 3.8],
      [-6.0, 1.68, 1.45, -0.3, 4.6],
      [3.6, 1.68, 1.45, -0.3, 4.6],
      [5.6, 1.45, 1.25, 0.0, 4],
      [7.6, 0.75, 0.8, 0.55, 3],
    ],
    boom: [6.6, 0.6, 0.72, 13.6, 1.35, 0.32],
    fin: [12.6, 1.2, 3.6, 1.9, 1.5],
    stabiliser: [14.0, 3.9, 3.4, 1.1],
    tailRotor: [-1, 3.0, 4, 3.1],
    glassParts: [
      [0, -0.2, -7.9, 1.42, 0.82, 1.15],
      [0, -1.1, -8.6, 0.8, 0.35, 0.5],
    ],
    pods: [
      [-1.5, 1.35, -0.6, 0.55, 0.5, 2.1],
      [1.5, 1.35, -0.6, 0.55, 0.5, 2.1],
      [0, 1.75, 1.6, 0.6, 0.52, 2.2],
      [0, 1.55, -2.6, 1.1, 0.5, 2.0],
    ],
    slabs: [
      [-2.25, -1.15, 1.6, 1.3, 0.85, 5.2],
      [2.25, -1.15, 1.6, 1.3, 0.85, 5.2],
    ],
    darkSlabs: [
      [-1.5, 1.35, 1.75, 0.42, 0.38, 0.5],
      [1.5, 1.35, 1.75, 0.42, 0.38, 0.5],
      [0, -0.4, -9.9, 0.12, 0.12, 1.4],
    ],
    mastBase: 1.7,
    droop: 0.09,
    eye: [0.75, 0.15, -7.2],
    cockpit: { shield: -0.2, pillar: 1.35, reach: 1.05, roof: 0.8 },
    wheelRadius: 0.45,
    audio: { turbineHz: 3400, turbineGain: 0.5, rumbleHz: 48, slap: 0.7, gain: 1.25 },
  },

  attack: {
    paint: 0x5a5a44,
    accent: 0x4a4a38,
    glass: 0x1a2620,
    fuselage: [
      [-6.4, 0.16, 0.18, -0.7, 2.2],
      [-5.9, 0.42, 0.42, -0.6, 2.8],
      [-4.8, 0.56, 0.72, -0.3, 3.2],
      [-3.2, 0.6, 1.0, -0.05, 3.4],
      [-1.4, 0.62, 1.08, 0.0, 3.6],
      [1.2, 0.6, 0.95, 0.0, 3.4],
      [2.8, 0.42, 0.6, 0.15, 2.8],
      [4.0, 0.25, 0.34, 0.3, 2.4],
    ],
    boom: [3.4, 0.3, 0.3, 8.6, 0.6, 0.16],
    fin: [7.7, 0.5, 2.5, 1.2, 1.1],
    stabiliser: [8.6, 0.5, 3.3, 0.8],
    tailRotor: [-1, 1.4, 4, 2.0],
    glassParts: [
      [0, 0.28, -4.5, 0.5, 0.52, 1.05],
      [0, 0.62, -3.0, 0.5, 0.5, 1.0],
    ],
    pods: [
      [-1.0, 0.25, 0.4, 0.42, 0.42, 1.6],
      [1.0, 0.25, 0.4, 0.42, 0.42, 1.6],
      [-2.25, -0.55, -0.5, 0.24, 0.24, 1.3],
      [2.25, -0.55, -0.5, 0.24, 0.24, 1.3],
    ],
    slabs: [
      [-1.6, -0.3, -0.5, 2.1, 0.14, 0.95],
      [1.6, -0.3, -0.5, 2.1, 0.14, 0.95],
    ],
    darkSlabs: [
      [0, -1.05, -4.4, 0.16, 0.16, 1.5],
      [0, -0.75, -5.9, 0.4, 0.4, 0.4],
      [-1.0, 0.25, 2.1, 0.34, 0.34, 0.4],
      [1.0, 0.25, 2.1, 0.34, 0.34, 0.4],
    ],
    mastBase: 1.1,
    droop: 0.05,
    eye: [0, 0.82, -2.95],
    cockpit: { shield: 0.42, pillar: 0.48, reach: 0.8, roof: 0.52 },
    wheelRadius: 0.34,
    audio: { turbineHz: 4700, turbineGain: 0.45, rumbleHz: 76, slap: 0.6, gain: 1.0 },
  },

  gunship: {
    paint: 0x3d4448,
    accent: 0x2f3539,
    glass: 0x16222a,
    fuselage: [
      [-6.8, 0.18, 0.2, -0.72, 2.2],
      [-6.3, 0.46, 0.46, -0.62, 2.8],
      [-5.1, 0.62, 0.78, -0.3, 3.2],
      [-3.4, 0.68, 1.06, -0.05, 3.6],
      [-1.4, 0.72, 1.14, 0.0, 3.8],
      [1.3, 0.7, 1.0, 0.0, 3.6],
      [3.0, 0.46, 0.64, 0.15, 2.8],
      [4.3, 0.27, 0.36, 0.32, 2.4],
    ],
    boom: [3.6, 0.32, 0.32, 9.2, 0.64, 0.17],
    fin: [8.2, 0.52, 2.7, 1.3, 1.15],
    stabiliser: [9.1, 0.52, 3.6, 0.85],
    tailRotor: [-1, 1.5, 4, 2.15],
    glassParts: [
      [0, 0.3, -4.8, 0.55, 0.55, 1.1],
      [0, 0.66, -3.2, 0.55, 0.52, 1.05],
    ],
    pods: [
      // Engines.
      [-1.1, 0.28, 0.4, 0.46, 0.46, 1.7],
      [1.1, 0.28, 0.4, 0.46, 0.46, 1.7],
      // Pylon fairings over the missile packs.
      [-1.5, -0.4, -0.7, 0.22, 0.14, 0.75],
      [1.5, -0.4, -0.7, 0.22, 0.14, 0.75],
      [-2.62, -0.4, -0.7, 0.22, 0.14, 0.75],
      [2.62, -0.4, -0.7, 0.22, 0.14, 0.75],
    ],
    // Long stub wings with endplates for the four pylons.
    slabs: [
      [-2.05, -0.28, -0.7, 2.9, 0.16, 1.2],
      [2.05, -0.28, -0.7, 2.9, 0.16, 1.2],
      [-3.5, -0.42, -0.7, 0.08, 0.5, 1.1],
      [3.5, -0.42, -0.7, 0.08, 0.5, 1.1],
    ],
    darkSlabs: [
      [0, -1.12, -4.8, 0.17, 0.17, 1.6],
      [0, -0.8, -6.3, 0.42, 0.42, 0.42],
      [-1.1, 0.28, 2.2, 0.36, 0.36, 0.42],
      [1.1, 0.28, 2.2, 0.36, 0.36, 0.42],
    ],
    mastBase: 1.15,
    droop: 0.05,
    eye: [0, 0.86, -3.15],
    cockpit: { shield: 0.46, pillar: 0.52, reach: 0.82, roof: 0.54 },
    wheelRadius: 0.36,
    audio: { turbineHz: 4500, turbineGain: 0.47, rumbleHz: 70, slap: 0.65, gain: 1.05 },
  },

  rescue: {
    paint: 0xf1f0ec,
    accent: 0xe2571c,
    band: [-1.0, 1.4],
    glass: 0x12222c,
    fuselage: [
      [-5.3, 0.15, 0.18, -0.6, 2],
      [-4.8, 0.6, 0.5, -0.5, 2.4],
      [-3.8, 1.0, 0.82, -0.3, 2.8],
      [-2.4, 1.14, 0.98, -0.15, 3.2],
      [1.4, 1.14, 0.98, -0.15, 3.2],
      [2.7, 0.85, 0.78, 0.1, 2.8],
      [3.9, 0.36, 0.42, 0.42, 2.2],
    ],
    boom: [3.3, 0.4, 0.4, 7.9, 0.95, 0.17],
    fin: [7.1, 0.85, 2.3, 1.25, 1.2],
    stabiliser: [7.0, 0.9, 3.1, 0.7],
    tailRotor: [1, 1.35, 4, 1.95],
    glassParts: [
      [0, 0.0, -3.95, 0.92, 0.62, 1.0],
      [0, -0.62, -4.6, 0.5, 0.26, 0.4],
    ],
    pods: [[0, 1.0, 0.5, 0.95, 0.42, 2.0]],
    slabs: [
      [-1.25, -0.85, 0.6, 0.42, 0.42, 2.6],
      [1.25, -0.85, 0.6, 0.42, 0.42, 2.6],
    ],
    darkSlabs: [
      [-0.5, 1.05, 2.35, 0.3, 0.26, 0.4],
      [0.5, 1.05, 2.35, 0.3, 0.26, 0.4],
      [1.3, 0.9, -1.2, 0.3, 0.2, 0.5],
    ],
    mastBase: 1.2,
    droop: 0.05,
    eye: [0.5, 0.2, -3.4],
    cockpit: { shield: -0.12, pillar: 0.9, reach: 0.9, roof: 0.74 },
    wheelRadius: 0.3,
    audio: { turbineHz: 4900, turbineGain: 0.4, rumbleHz: 80, slap: 0.35, gain: 0.95 },
  },
};
