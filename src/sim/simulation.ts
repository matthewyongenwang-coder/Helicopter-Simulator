import type { AircraftData } from '../data/aircraft';
import type { Action } from '../data/controls';
import { TUNING } from '../data/tuning';
import { ActionState, type Bindings } from './controls';
import { deriveAircraft } from './derive';
import { Helicopter, type SpawnOptions } from './helicopter';
import { neutralInput, type ControlInput, type Environment } from './types';

export const FIXED_DT = 1 / TUNING.stepHz;

export interface KeyEvent {
  /** Seconds from the start of the script. */
  t: number;
  press?: string;
  release?: string;
}

/**
 * The flight model on a fixed 120 Hz clock, driven by key codes.
 * The game feeds it real key events and frame times; tests feed it scripts.
 */
export class Simulation {
  readonly heli: Helicopter;
  readonly actions: ActionState;
  readonly input: ControlInput = neutralInput();
  time = 0;
  /** Fraction of a step left over after the last advance(), for render interpolation. */
  alpha = 0;
  private acc = 0;
  /** One-shot game actions (camera, pause…) collected for the shell. */
  private gameActions: Action[] = [];

  constructor(data: AircraftData, env: Environment, spawn: SpawnOptions, bindings?: Bindings, seed = 1) {
    this.heli = new Helicopter(deriveAircraft(data), env, seed);
    this.heli.spawn(spawn);
    this.actions = new ActionState(bindings);
  }

  keyDown(code: string): boolean {
    return this.actions.keyDown(code);
  }
  keyUp(code: string): boolean {
    return this.actions.keyUp(code);
  }

  /** One-shot non-flight actions pressed since the last call. */
  takeGameActions(): Action[] {
    const out = this.gameActions;
    this.gameActions = [];
    return out;
  }

  /** Run exactly one fixed step. */
  tick(): void {
    const input = this.input;
    this.actions.readAxes(input);
    input.engineToggle = input.autohoverToggle = input.brakeToggle = false;
    for (const a of this.actions.takePressed()) {
      if (a === 'engineToggle') input.engineToggle = true;
      else if (a === 'autohoverToggle') input.autohoverToggle = true;
      else if (a === 'wheelBrake') input.brakeToggle = true;
      else this.gameActions.push(a);
    }
    this.heli.step(FIXED_DT, input);
    this.time += FIXED_DT;
  }

  /** Advance by real elapsed time, running as many fixed steps as fit (capped). */
  advance(dtReal: number, maxSteps = 12): number {
    this.acc += Math.min(dtReal, 0.25);
    let n = 0;
    while (this.acc >= FIXED_DT && n < maxSteps) {
      this.tick();
      this.acc -= FIXED_DT;
      n++;
    }
    if (this.acc > FIXED_DT) this.acc = FIXED_DT; // drop time we could not simulate
    this.alpha = this.acc / FIXED_DT;
    return n;
  }

  /** Run for a number of seconds with the keys as they are. Returns after ticking. */
  run(seconds: number, each?: (sim: Simulation) => void): void {
    const steps = Math.round(seconds * TUNING.stepHz);
    for (let i = 0; i < steps; i++) {
      this.tick();
      if (each) each(this);
    }
  }

  /** Replay a key script, then keep running until `until` seconds. */
  play(script: KeyEvent[], until: number, each?: (sim: Simulation) => void): void {
    const events = [...script].sort((a, b) => a.t - b.t);
    const t0 = this.time;
    let i = 0;
    const steps = Math.round(until * TUNING.stepHz);
    for (let s = 0; s < steps; s++) {
      const t = s * FIXED_DT;
      while (i < events.length && events[i].t <= t + 1e-9) {
        const e = events[i++];
        if (e.press) this.keyDown(e.press);
        if (e.release) this.keyUp(e.release);
      }
      this.tick();
      if (each) each(this);
    }
    void t0;
  }
}
