/**
 * Armament, countermeasures and the enemy's guns. All positions are body axes
 * (+X right, +Y up, −Z forward, metres from the CG); speeds m/s, times s.
 * Damage to the player is a fraction of airframe health before the aircraft's
 * own fragility is applied; damage to compounds is in hit points.
 */

export type V3 = [number, number, number];

export interface GunSpec {
  name: string;
  /** Rounds per second. */
  rate: number;
  ammo: number;
  /** Muzzle velocity. */
  speed: number;
  /** Hit points per round, and the radius a round's burst reaches. */
  damage: number;
  splash: number;
  /** Round-to-round dispersion, radians. */
  spread: number;
  /** Barrels fire in turn. */
  muzzles: V3[];
  /** Turret travel: ± yaw and the pitch range, degrees. Small numbers for fixed guns. */
  yawLimit: number;
  pitchMin: number;
  pitchMax: number;
  /** Every n-th round is a tracer. */
  tracerEvery: number;
}

export interface MissileSpec {
  name: string;
  /** Rails in firing order (alternate sides). Their count is the load. */
  rails: V3[];
  /** Top speed, motor acceleration and burn time. */
  speed: number;
  accel: number;
  burn: number;
  /** Largest sideways acceleration the fins can pull, m/s². */
  turn: number;
  life: number;
  damage: number;
  radius: number;
  /** Seconds between launches. */
  reload: number;
  /** Seeker: time to lock, range, and the cone around the sight line it searches, degrees. */
  lockTime: number;
  lockRange: number;
  lockCone: number;
}

export interface Loadout {
  gun?: GunSpec;
  missile?: MissileSpec;
  /** Flare cartridges carried, and how many one press of the dispenser fires. */
  flares: number;
  salvo: number;
  /** Where the dispensers sit (left and right). */
  dispensers: V3[];
}

const hellfire = (rails: V3[]): MissileSpec => ({
  name: 'Missile',
  rails,
  speed: 420,
  accel: 260,
  burn: 2.4,
  turn: 260,
  life: 13,
  damage: 300,
  radius: 16,
  reload: 0.55,
  lockTime: 0.7,
  lockRange: 5000,
  lockCone: 9,
});

export const LOADOUTS: Record<string, Loadout> = {
  scout: {
    gun: {
      name: '12.7 mm pods', rate: 15, ammo: 900, speed: 900, damage: 7, splash: 0, spread: 0.0035,
      muzzles: [[-1.05, -0.62, -1.3], [1.05, -0.62, -1.3]], yawLimit: 6, pitchMin: -12, pitchMax: 4, tracerEvery: 3,
    },
    missile: hellfire([[-1.42, -0.62, -0.45], [1.42, -0.62, -0.45]]),
    flares: 30,
    salvo: 4,
    dispensers: [[-0.6, -0.3, 1.0], [0.6, -0.3, 1.0]],
  },
  utility: { flares: 30, salvo: 4, dispensers: [[-1.2, -0.6, 1.8], [1.2, -0.6, 1.8]] },
  medium: {
    gun: {
      name: '20 mm turret', rate: 12, ammo: 750, speed: 1000, damage: 10, splash: 2, spread: 0.0035,
      muzzles: [[0, -1.24, -5.75]], yawLimit: 110, pitchMin: -60, pitchMax: 15, tracerEvery: 3,
    },
    missile: hellfire([[-2.05, -0.78, -0.55], [2.05, -0.78, -0.55], [-2.42, -0.78, -0.55], [2.42, -0.78, -0.55]]),
    flares: 60,
    salvo: 6,
    dispensers: [[-1.1, -0.5, 2.6], [1.1, -0.5, 2.6]],
  },
  heavy: { flares: 90, salvo: 6, dispensers: [[-1.9, -0.9, 4.2], [1.9, -0.9, 4.2]] },
  attack: {
    gun: {
      name: '30 mm chin turret', rate: 10, ammo: 600, speed: 1050, damage: 16, splash: 3, spread: 0.003,
      muzzles: [[0, -1.05, -5.2]], yawLimit: 110, pitchMin: -60, pitchMax: 18, tracerEvery: 2,
    },
    missile: hellfire([
      [-1.2, -0.62, -0.75], [1.2, -0.62, -0.75], [-1.52, -0.62, -0.75], [1.52, -0.62, -0.75],
      [-1.2, -0.94, -0.75], [1.2, -0.94, -0.75], [-1.52, -0.94, -0.75], [1.52, -0.94, -0.75],
    ]),
    flares: 60,
    salvo: 6,
    dispensers: [[-0.6, -0.2, 3.0], [0.6, -0.2, 3.0]],
  },
  rescue: { flares: 30, salvo: 4, dispensers: [[-1.1, -0.5, 1.8], [1.1, -0.5, 1.8]] },
};

/** One-line summary for the menu. */
export function armamentText(id: string): string {
  const l = LOADOUTS[id];
  if (!l) return '—';
  const parts: string[] = [];
  if (l.gun) parts.push(l.gun.name);
  if (l.missile) parts.push(`${l.missile.rails.length} missiles`);
  parts.push(`${l.flares} flares`);
  return parts.join(' · ');
}

export interface EnemyGun {
  range: number;
  speed: number;
  rate: number;
  burstMin: number;
  burstMax: number;
  pauseMin: number;
  pauseMax: number;
  damage: number;
  spread: number;
  /** Aim error per burst: a base and a part that grows with the target's speed (per m/s). */
  bias: number;
  biasPerSpeed: number;
  /** Rounds burst near the target (flak) inside this distance. 0 = solid shot. */
  proximity: number;
  /** Slew rate of the mount, rad/s. */
  slew: number;
}

export const ENEMY = {
  mg: {
    range: 1100, speed: 820, rate: 11, burstMin: 6, burstMax: 11, pauseMin: 1.3, pauseMax: 2.6,
    damage: 0.011, spread: 0.006, bias: 0.012, biasPerSpeed: 0.00022, proximity: 0, slew: 1.6,
  } satisfies EnemyGun,
  aaa: {
    range: 1700, speed: 950, rate: 9, burstMin: 8, burstMax: 14, pauseMin: 2.0, pauseMax: 3.2,
    damage: 0.028, spread: 0.007, bias: 0.016, biasPerSpeed: 0.00025, proximity: 9, slew: 1.1,
  } satisfies EnemyGun,
  sam: {
    range: 3300,
    minRange: 280,
    /** The target must be at least this high above the ground for the seeker to see it. */
    minAgl: 14,
    lockTime: 2.4,
    reload: 9,
    speed: 390,
    accel: 210,
    burn: 2.6,
    turn: 175,
    life: 13,
    damage: 0.5,
    fuse: 9,
    /** Chance one flare salvo pulls a missile off. */
    decoy: 0.8,
  },
};

/** Where compounds are placed and how tough they are. */
export const COMPOUNDS = {
  /** One candidate site per cell of this size. */
  cell: 3400,
  chance: 0.55,
  /** No compound this close to the start. */
  homeClear: 4500,
  /** Away from towns and roads. */
  settlementClear: 1100,
  roadClear: 90,
  /** Steepest height change across the site, m. */
  maxRelief: 16,
  /** Load, and unload, compounds inside / outside these ranges. */
  activeRange: 7000,
  dropRange: 8000,
  /** The compound falls when its remaining strength drops to this fraction. */
  breakAt: 0.4,
};
