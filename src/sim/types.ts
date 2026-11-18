import type { AircraftData } from '../data/aircraft';
import type { Vec3 } from './math';

/** Pilot input for one physics step, already reduced from keys to axes. */
export interface ControlInput {
  /** +1 = nose down (W), −1 = nose up (S). */
  pitch: number;
  /** +1 = roll right (D). */
  roll: number;
  /** +1 = yaw right (E). */
  yaw: number;
  /** +1 = raise the lever (Space), −1 = lower it (Shift). */
  collective: number;
  /** One-shot edges. */
  engineToggle: boolean;
  autohoverToggle: boolean;
  brakeToggle: boolean;
}

export function neutralInput(): ControlInput {
  return { pitch: 0, roll: 0, yaw: 0, collective: 0, engineToggle: false, autohoverToggle: false, brakeToggle: false };
}

export const enum SurfaceKind {
  Terrain = 0,
  Water = 1,
  Structure = 2,
  Helipad = 3,
  Road = 4,
}

export interface SurfaceHit {
  height: number;
  nx: number;
  ny: number;
  nz: number;
  kind: SurfaceKind;
}

export interface SphereContact {
  /** Penetration depth, m. */
  depth: number;
  /** Outward surface normal. */
  nx: number;
  ny: number;
  nz: number;
}

/** Everything the flight model needs to know about the outside world. */
export interface Environment {
  /**
   * Highest solid or water surface at (x, z) that is not above `y + 2`.
   * The probe height lets roofs and bridge decks be landed on without the
   * ground under them (or a roof far overhead) being returned instead.
   */
  surface(x: number, z: number, y: number, out: SurfaceHit): void;
  /** Wind velocity (world, m/s) including gusts at a point and time. */
  wind(x: number, y: number, z: number, t: number, out: Vec3): void;
  /** Air density, kg/m³. */
  density(y: number): number;
  /** Sphere test against walls and other obstacles. Returns false when clear. */
  collide?(x: number, y: number, z: number, r: number, out: SphereContact): boolean;
}

export type EngineState = 'off' | 'starting' | 'running' | 'failed';

/** Coefficients derived from AircraftData. All SI, radians. */
export interface Aircraft {
  data: AircraftData;
  // Rotor
  R: number;
  area: number;
  sigma: number;
  omega0: number; // rad/s at 100 %
  rotorInertia: number;
  thetaMin: number;
  thetaMax: number;
  ctMax: number;
  // Engine
  powerMax: number; // W
  torqueRated: number; // N·m at the rotor shaft
  /** Torque limit during the start sequence, N·m. Too little to lift off at any weight. */
  startTorque: number;
  burnRated: number; // kg/s
  // Mass
  stdMass: number;
  // Drag (flat-plate areas, m²)
  fFwd: number;
  fSide: number;
  fVert: number;
  finArea: number; // fin side-force area × lift slope, m²
  // Inertia about body axes
  Ixx: number;
  Iyy: number;
  Izz: number;
  // Handling (rad/s)
  pitchRate: number;
  rollRate: number;
  yawRate: number;
  // Yaw
  tailTorqueMax: number;
  /** Pedal needed in the hover at standard mass, and its slope with collective. */
  pedalHover: number;
  pedalSlope: number;
  hoverCollective: number;
  // Speed limits (m/s)
  topSpeed: number;
  vne: number;
  // Contact
  gearK: number[];
  gearC: number[];
  rotorTips: [number, number, number][];
  /** CG height above the ground when resting at standard mass. */
  restHeight: number;
  // Autohover (rad, rad/s)
  ahMaxTilt: number;
  ahMaxRate: number;
  // Menu figures computed from the model
  computed: {
    hoverPowerFraction: number;
    maxClimb: number; // m/s at best-climb speed, standard mass
    bestClimbSpeed: number; // m/s
    hoverCeiling: number; // m, out of ground effect at standard mass
    endurance: number; // hours at cruise
    range: number; // km at cruise
    cruiseSpeed: number; // m/s
    powerToWeight: number; // kW/kg at standard mass
    diskLoading: number; // kg/m²
  };
}

/** Warning bit flags for the HUD and audio. */
export const enum Warn {
  LowFuel = 1 << 3,
  EngineOut = 1 << 4,
  SinkRate = 1 << 8,
  TailRotor = 1 << 9,
  LowerCollective = 1 << 10,
  Damage = 1 << 11,
  Terrain = 1 << 12,
  AutohoverUnavailable = 1 << 13,
}

/** Read-only snapshot of derived flight values, refreshed every step. */
export interface Telemetry {
  time: number;
  mass: number;
  airspeed: number; // m/s, air-relative
  groundSpeed: number; // m/s, horizontal
  verticalSpeed: number;
  radarAlt: number; // m, lowest gear point above the surface
  baroAlt: number; // m above the water datum
  heading: number;
  pitch: number;
  roll: number;
  yawRate: number;
  rotorRpm: number; // fraction of nominal
  torque: number; // fraction of rated
  collective: number; // lever 0–1
  pedal: number; // −1..1 total tail rotor command
  thrust: number; // N
  power: number; // W shaft
  gLoad: number;
  onGround: boolean;
  gearLoad: number; // fraction of weight carried by the gear
  inGroundEffect: number; // 0–1
  translationalLift: number; // 0–1
  vortexRing: number; // 0–1
  vibration: number; // 0–1 for camera shake and audio
  fuel: number; // kg
  fuelFraction: number;
  fuelFlow: number; // kg/s
  health: number;
  warnings: number;
  surfaceKind: SurfaceKind;
  lastImpact: number; // m/s, most recent touchdown speed (for UI/audio)
  impactCount: number;
}
