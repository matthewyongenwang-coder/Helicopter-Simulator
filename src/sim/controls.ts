import { DEFAULT_BINDINGS, type Action, type FlightAction } from '../data/controls';
import type { ControlInput } from './types';

export type Bindings = Record<Action, string[]>;

/**
 * Tracks which actions are held and which one-shot actions fired, from raw key
 * codes and a binding table. Pure: the DOM layer and the tests both feed it.
 */
export class ActionState {
  private bindings: Bindings;
  private codeToActions = new Map<string, Action[]>();
  private heldCodes = new Set<string>();
  private held = new Map<Action, number>();
  private pressed: Action[] = [];

  constructor(bindings: Bindings = DEFAULT_BINDINGS) {
    this.bindings = bindings;
    this.rebuild();
  }

  setBindings(bindings: Bindings): void {
    this.bindings = bindings;
    this.rebuild();
    this.releaseAll();
  }

  private rebuild(): void {
    this.codeToActions.clear();
    for (const action of Object.keys(this.bindings) as Action[]) {
      for (const code of this.bindings[action]) {
        const list = this.codeToActions.get(code);
        if (list) list.push(action);
        else this.codeToActions.set(code, [action]);
      }
    }
  }

  /** Returns true if the key is bound to something. */
  keyDown(code: string): boolean {
    const actions = this.codeToActions.get(code);
    if (!actions) return false;
    if (this.heldCodes.has(code)) return true; // auto-repeat
    this.heldCodes.add(code);
    for (const a of actions) {
      this.held.set(a, (this.held.get(a) ?? 0) + 1);
      this.pressed.push(a);
    }
    return true;
  }

  keyUp(code: string): boolean {
    const actions = this.codeToActions.get(code);
    if (!actions) return false;
    if (!this.heldCodes.delete(code)) return true;
    for (const a of actions) {
      const n = (this.held.get(a) ?? 1) - 1;
      if (n <= 0) this.held.delete(a);
      else this.held.set(a, n);
    }
    return true;
  }

  releaseAll(): void {
    this.heldCodes.clear();
    this.held.clear();
    this.pressed.length = 0;
  }

  isHeld(action: Action): boolean {
    return this.held.has(action);
  }

  /** Actions pressed since the last call. Clears the queue. */
  takePressed(): Action[] {
    if (this.pressed.length === 0) return EMPTY;
    const out = this.pressed;
    this.pressed = [];
    return out;
  }

  /** Fill the continuous axes of a ControlInput from the held flight actions. */
  readAxes(out: ControlInput): void {
    const ax = (pos: FlightAction, neg: FlightAction) => (this.held.has(pos) ? 1 : 0) - (this.held.has(neg) ? 1 : 0);
    out.pitch = ax('pitchDown', 'pitchUp');
    out.roll = ax('rollRight', 'rollLeft');
    out.yaw = ax('yawRight', 'yawLeft');
    out.collective = ax('collectiveUp', 'collectiveDown');
  }
}

const EMPTY: Action[] = [];
