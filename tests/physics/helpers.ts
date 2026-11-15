import { AIRCRAFT } from '../../src/data/aircraft';
import { FlatEnvironment } from '../../src/sim/environment';
import type { Helicopter, SpawnOptions } from '../../src/sim/helicopter';
import { RAD } from '../../src/sim/math';
import { Simulation } from '../../src/sim/simulation';

export interface Rig {
  sim: Simulation;
  heli: Helicopter;
  env: FlatEnvironment;
}

/** Aircraft parked on flat ground, engine off. */
export function onGround(id = 'medium', spawn: Partial<SpawnOptions> = {}): Rig {
  const env = new FlatEnvironment();
  const sim = new Simulation(AIRCRAFT[id], env, { x: 0, y: 0, z: 0, ...spawn });
  return { sim, heli: sim.heli, env };
}

/** Aircraft in a trimmed hover at `alt` metres, engine running. */
export function inHover(id = 'medium', alt = 60, spawn: Partial<SpawnOptions> = {}, settle = 1): Rig {
  const env = new FlatEnvironment();
  const sim = new Simulation(AIRCRAFT[id], env, { x: 0, y: alt, z: 0, airborne: true, ...spawn });
  sim.run(settle); // let the inflow and governor settle
  return { sim, heli: sim.heli, env };
}

/** Press and release a key within one physics step. */
export function tap(sim: Simulation, code: string): void {
  sim.keyDown(code);
  sim.tick();
  sim.keyUp(code);
}

/** Hold a key for a duration, then release it. */
export function hold(sim: Simulation, code: string, seconds: number): void {
  sim.keyDown(code);
  sim.run(seconds);
  sim.keyUp(code);
}

/** Hold a key until a condition is met (or a timeout), then release. Returns seconds held. */
export function holdUntil(sim: Simulation, code: string, done: () => boolean, timeout = 30): number {
  const t0 = sim.time;
  sim.keyDown(code);
  while (!done() && sim.time - t0 < timeout) sim.tick();
  sim.keyUp(code);
  return sim.time - t0;
}

/** Run until a condition is met. Returns seconds taken, or Infinity on timeout. */
export function runUntil(sim: Simulation, done: () => boolean, timeout = 60): number {
  const t0 = sim.time;
  while (!done()) {
    if (sim.time - t0 >= timeout) return Infinity;
    sim.tick();
  }
  return sim.time - t0;
}

/** Angle between the rotor axis and vertical, degrees. */
export function tiltDeg(h: Helicopter): number {
  const up = (h as unknown as { up: { y: number } }).up;
  return Math.acos(Math.min(1, Math.max(-1, up.y))) * RAD;
}

export const deg = (rad: number) => rad * RAD;

/** Smallest signed difference between two headings in degrees. */
export function headingDiff(a: number, b: number): number {
  let d = (a - b) * RAD;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

export interface HoverCriteria {
  tilt: number; // deg
  speed: number; // m/s, 3-D
  rate: number; // deg/s, any axis
}
export const STILL: HoverCriteria = { tilt: 3, speed: 0.5, rate: 5 };

export function isStill(h: Helicopter, c: HoverCriteria = STILL): boolean {
  return tiltDeg(h) < c.tilt && h.vel.len() < c.speed && h.omega.len() * RAD < c.rate;
}

/**
 * Run for `window` seconds and return the time after which the aircraft stayed
 * level and motionless for the rest of the window. Infinity if it never did.
 */
export function settleTime(sim: Simulation, window: number, c: HoverCriteria = STILL): number {
  const t0 = sim.time;
  let lastBad = 0;
  const steps = Math.round(window * 120);
  for (let i = 0; i < steps; i++) {
    sim.tick();
    if (!isStill(sim.heli, c)) lastBad = sim.time - t0;
  }
  return lastBad >= window - 1e-6 ? Infinity : lastBad;
}

/** Start the engine with J and wait for the rotor to reach flight RPM. Returns seconds taken. */
export function startEngine(sim: Simulation): number {
  tap(sim, 'KeyJ');
  return runUntil(sim, () => sim.heli.engine === 'running' && sim.heli.rotorN > 0.99, 60);
}
