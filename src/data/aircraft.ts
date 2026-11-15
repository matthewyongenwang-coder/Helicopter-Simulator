/**
 * Aircraft definitions. These are the only per-aircraft numbers in the game;
 * sim/derive.ts turns them into the coefficients the physics uses.
 *
 * Units: kg, m, kW, knots, degrees, seconds. Body axes: +X right, +Y up, −Z forward,
 * origin at the centre of gravity.
 */

export type GearType = 'skids' | 'wheels';

export interface AircraftData {
  id: string;
  name: string;
  designation: string;
  role: string;
  blurb: string;

  mass: {
    empty: number;
    maxTakeoff: number;
    crew: number;
    /** Payload carried at the "standard" spawn loading. */
    payloadStd: number;
  };
  fuel: {
    capacity: number; // kg
    /** Burn at rated power, kg/h. */
    burnRated: number;
    /** Burn at zero shaft power as a fraction of rated burn. */
    idleFraction: number;
  };
  rotor: {
    diameter: number;
    blades: number;
    chord: number;
    tipSpeed: number; // m/s at 100 %
    /** Hub height above the CG. */
    hubHeight: number;
  };
  tail: {
    /** Distance from CG back to the tail rotor. */
    arm: number;
    /** Tail rotor effectiveness in the hover relative to cruise (0–1). */
    lowSpeedAuthority: number;
    /** Fraction of the collective-induced torque change the pedal interlink cancels. */
    interlink: number;
  };
  engine: {
    count: number;
    /** Usable (transmission-limited) power, kW. */
    powerKW: number;
    /** Seconds for the start sequence to bring the rotor to 100 %. */
    spoolTime: number;
    /** Turbine torque response time constant, s. */
    responseTau: number;
  };
  perf: {
    topSpeedKts: number;
    vneKts: number;
  };
  handling: {
    /** Steady attitude rates with a key held, deg/s. */
    pitchRate: number;
    rollRate: number;
    yawRate: number;
    /** Time constant of the rate response, s. Larger = more sluggish. */
    attTau: number;
    yawTau: number;
    /** Collective lever travel per second with a key held (0–1 per s). */
    collectiveRate: number;
  };
  autohover: {
    maxTilt: number; // deg
    maxRate: number; // deg/s the controller will rotate at
    /** Full-cyclic authority as a multiple of maxRate (control power for the rate loop). */
    authority: number;
  };
  body: {
    length: number;
    width: number;
    height: number;
    /** Flat-plate drag area sideways / vertically as multiples of the forward area. */
    sideDrag: number;
    vertDrag: number;
    /** Radii of gyration as fractions of length (pitch, yaw) and width+height (roll). */
    gyration: number;
  };
  gear: {
    type: GearType;
    /** Contact points at full extension. */
    points: [number, number, number][];
    stroke: number;
  };
  /** Rigid hull contact spheres [x, y, z, radius, kind]. kind: 0 hull, 1 tail. */
  hull: [number, number, number, number, number][];
  damage: {
    /** Multiplier on damage taken. Lower is tougher. */
    fragility: number;
    /** Touchdown sink rate where damage starts / destroys the aircraft, m/s. */
    hardLanding: number;
    crash: number;
  };
}

const scout: AircraftData = {
  id: 'scout',
  name: 'Wasp',
  designation: 'LS-5',
  role: 'Light scout',
  blurb: 'Tiny, twitchy and fast on the controls. Rewards a light touch and punishes a heavy one.',
  mass: { empty: 720, maxTakeoff: 1406, crew: 170, payloadStd: 90 },
  fuel: { capacity: 190, burnRated: 105, idleFraction: 0.3 },
  rotor: { diameter: 8.05, blades: 5, chord: 0.171, tipSpeed: 207, hubHeight: 1.45 },
  tail: { arm: 4.6, lowSpeedAuthority: 0.86, interlink: 0.25 },
  engine: { count: 1, powerKW: 300, spoolTime: 12, responseTau: 0.35 },
  perf: { topSpeedKts: 135, vneKts: 152 },
  handling: { pitchRate: 58, rollRate: 80, yawRate: 95, attTau: 0.09, yawTau: 0.22, collectiveRate: 0.5 },
  autohover: { maxTilt: 52, maxRate: 230, authority: 2.0 },
  body: { length: 7.0, width: 1.45, height: 2.6, sideDrag: 4.5, vertDrag: 6.5, gyration: 0.19 },
  gear: {
    type: 'skids',
    points: [
      [-0.98, -1.2, -1.15],
      [0.98, -1.2, -1.15],
      [-0.98, -1.2, 1.05],
      [0.98, -1.2, 1.05],
    ],
    stroke: 0.22,
  },
  hull: [
    [0, -0.55, -1.7, 0.55, 0],
    [0, -0.35, 0.3, 0.6, 0],
    [0, 0.25, 4.6, 0.3, 1],
    [0, 1.0, 4.9, 0.25, 1],
  ],
  damage: { fragility: 1.35, hardLanding: 2.4, crash: 8.0 },
};

const utility: AircraftData = {
  id: 'utility',
  name: 'Mule',
  designation: 'UT-12',
  role: 'Utility transport',
  blurb: 'Two broad blades and an honest, steady feel. The classic whop-whop workhorse.',
  mass: { empty: 2365, maxTakeoff: 4309, crew: 180, payloadStd: 450 },
  fuel: { capacity: 640, burnRated: 290, idleFraction: 0.3 },
  rotor: { diameter: 14.63, blades: 2, chord: 0.533, tipSpeed: 232, hubHeight: 2.25 },
  tail: { arm: 8.0, lowSpeedAuthority: 0.84, interlink: 0.25 },
  engine: { count: 1, powerKW: 1044, spoolTime: 14, responseTau: 0.5 },
  perf: { topSpeedKts: 118, vneKts: 124 },
  handling: { pitchRate: 32, rollRate: 40, yawRate: 48, attTau: 0.22, yawTau: 0.34, collectiveRate: 0.38 },
  autohover: { maxTilt: 46, maxRate: 165, authority: 2.0 },
  body: { length: 12.7, width: 2.6, height: 3.6, sideDrag: 5, vertDrag: 7, gyration: 0.18 },
  gear: {
    type: 'skids',
    points: [
      [-1.32, -1.45, -1.7],
      [1.32, -1.45, -1.7],
      [-1.32, -1.45, 1.55],
      [1.32, -1.45, 1.55],
    ],
    stroke: 0.26,
  },
  hull: [
    [0, -0.6, -2.9, 0.75, 0],
    [0, -0.45, 0.2, 0.85, 0],
    [0, 0.35, 7.6, 0.35, 1],
    [0, 1.9, 8.3, 0.3, 1],
  ],
  damage: { fragility: 1.0, hardLanding: 2.6, crash: 9.0 },
};

const medium: AircraftData = {
  id: 'medium',
  name: 'Nightjar',
  designation: 'MH-70',
  role: 'Medium assault',
  blurb: 'The all-rounder. Plenty of power, balanced handling, built to take a hard landing.',
  mass: { empty: 5350, maxTakeoff: 9980, crew: 270, payloadStd: 900 },
  fuel: { capacity: 1100, burnRated: 560, idleFraction: 0.28 },
  rotor: { diameter: 16.36, blades: 4, chord: 0.53, tipSpeed: 221, hubHeight: 2.0 },
  tail: { arm: 9.9, lowSpeedAuthority: 0.85, interlink: 0.25 },
  engine: { count: 2, powerKW: 2100, spoolTime: 15, responseTau: 0.45 },
  perf: { topSpeedKts: 159, vneKts: 180 },
  handling: { pitchRate: 36, rollRate: 46, yawRate: 55, attTau: 0.18, yawTau: 0.3, collectiveRate: 0.4 },
  autohover: { maxTilt: 48, maxRate: 180, authority: 2.0 },
  body: { length: 15.3, width: 2.4, height: 3.8, sideDrag: 5, vertDrag: 7, gyration: 0.18 },
  gear: {
    type: 'wheels',
    points: [
      [-1.36, -1.78, -1.25],
      [1.36, -1.78, -1.25],
      [0, -1.78, 7.6],
    ],
    stroke: 0.36,
  },
  hull: [
    [0, -0.7, -3.6, 0.85, 0],
    [0, -0.55, 0.4, 0.95, 0],
    [0, 0.2, 8.9, 0.4, 1],
    [0, 1.8, 9.9, 0.35, 1],
  ],
  damage: { fragility: 0.8, hardLanding: 3.0, crash: 11.0 },
};

const heavy: AircraftData = {
  id: 'heavy',
  name: 'Atlas',
  designation: 'CH-90',
  role: 'Heavy lift',
  blurb: 'Seven blades and three engines. Enormous power, enormous inertia. Plan every move early.',
  mass: { empty: 15070, maxTakeoff: 33300, crew: 400, payloadStd: 4000 },
  fuel: { capacity: 4500, burnRated: 2300, idleFraction: 0.26 },
  rotor: { diameter: 24.08, blades: 7, chord: 0.74, tipSpeed: 223, hubHeight: 2.9 },
  tail: { arm: 14.5, lowSpeedAuthority: 0.82, interlink: 0.25 },
  engine: { count: 3, powerKW: 9800, spoolTime: 19, responseTau: 0.7 },
  perf: { topSpeedKts: 150, vneKts: 160 },
  handling: { pitchRate: 15, rollRate: 19, yawRate: 22, attTau: 0.46, yawTau: 0.6, collectiveRate: 0.28 },
  autohover: { maxTilt: 38, maxRate: 95, authority: 2.0 },
  body: { length: 22.3, width: 3.4, height: 5.2, sideDrag: 5.5, vertDrag: 7.5, gyration: 0.175 },
  gear: {
    type: 'wheels',
    points: [
      [0, -2.5, -6.3],
      [-2.05, -2.5, 1.95],
      [2.05, -2.5, 1.95],
    ],
    stroke: 0.42,
  },
  hull: [
    [0, -1.0, -6.8, 1.2, 0],
    [0, -0.9, 0.0, 1.4, 0],
    [0, -0.6, 5.5, 1.2, 0],
    [0, 0.6, 12.8, 0.55, 1],
    [0, 2.8, 14.6, 0.45, 1],
  ],
  damage: { fragility: 0.75, hardLanding: 2.8, crash: 10.0 },
};

const attack: AircraftData = {
  id: 'attack',
  name: 'Shrike',
  designation: 'AH-9',
  role: 'Attack',
  blurb: 'Narrow, armoured and agile. Snaps into a bank and shrugs off punishment.',
  mass: { empty: 5165, maxTakeoff: 10400, crew: 200, payloadStd: 1100 },
  fuel: { capacity: 1100, burnRated: 540, idleFraction: 0.28 },
  rotor: { diameter: 14.63, blades: 4, chord: 0.533, tipSpeed: 221, hubHeight: 1.95 },
  tail: { arm: 8.9, lowSpeedAuthority: 0.87, interlink: 0.25 },
  engine: { count: 2, powerKW: 2300, spoolTime: 14, responseTau: 0.4 },
  perf: { topSpeedKts: 158, vneKts: 197 },
  handling: { pitchRate: 48, rollRate: 66, yawRate: 76, attTau: 0.12, yawTau: 0.25, collectiveRate: 0.44 },
  autohover: { maxTilt: 50, maxRate: 205, authority: 2.0 },
  body: { length: 14.7, width: 1.9, height: 3.8, sideDrag: 5.5, vertDrag: 7, gyration: 0.18 },
  gear: {
    type: 'wheels',
    points: [
      [-1.02, -1.7, -1.5],
      [1.02, -1.7, -1.5],
      [0, -1.7, 8.2],
    ],
    stroke: 0.4,
  },
  hull: [
    [0, -0.75, -4.2, 0.7, 0],
    [0, -0.55, 0.3, 0.8, 0],
    [0, 0.3, 8.4, 0.38, 1],
    [0, 2.0, 9.0, 0.32, 1],
  ],
  damage: { fragility: 0.55, hardLanding: 3.4, crash: 12.8 },
};

const rescue: AircraftData = {
  id: 'rescue',
  name: 'Petrel',
  designation: 'SAR-14',
  role: 'Rescue / medevac',
  blurb: 'Smooth, quick and stable in the hover. Made for precise work over water and rooftops.',
  mass: { empty: 3700, maxTakeoff: 6800, crew: 300, payloadStd: 500 },
  fuel: { capacity: 1250, burnRated: 430, idleFraction: 0.28 },
  rotor: { diameter: 13.8, blades: 5, chord: 0.4, tipSpeed: 214, hubHeight: 1.95 },
  tail: { arm: 8.3, lowSpeedAuthority: 0.88, interlink: 0.25 },
  engine: { count: 2, powerKW: 1900, spoolTime: 15, responseTau: 0.4 },
  perf: { topSpeedKts: 165, vneKts: 172 },
  handling: { pitchRate: 34, rollRate: 44, yawRate: 52, attTau: 0.16, yawTau: 0.28, collectiveRate: 0.42 },
  autohover: { maxTilt: 48, maxRate: 190, authority: 2.0 },
  body: { length: 13.5, width: 2.3, height: 3.7, sideDrag: 5, vertDrag: 7, gyration: 0.18 },
  gear: {
    type: 'wheels',
    points: [
      [0, -1.62, -3.3],
      [-1.5, -1.62, 1.05],
      [1.5, -1.62, 1.05],
    ],
    stroke: 0.34,
  },
  hull: [
    [0, -0.7, -3.4, 0.8, 0],
    [0, -0.55, 0.2, 0.9, 0],
    [0, 0.5, 7.4, 0.38, 1],
    [0, 2.1, 8.4, 0.32, 1],
  ],
  damage: { fragility: 0.9, hardLanding: 2.8, crash: 10.0 },
};

export const AIRCRAFT: Record<string, AircraftData> = { scout, utility, medium, heavy, attack, rescue };
export const AIRCRAFT_ORDER = ['scout', 'utility', 'medium', 'heavy', 'attack', 'rescue'] as const;
export type AircraftId = (typeof AIRCRAFT_ORDER)[number];
