/** Wires browser keyboard events to a key sink (the simulation). */
export interface KeySink {
  keyDown(code: string): boolean;
  keyUp(code: string): boolean;
}

export class KeyboardInput {
  private sink: KeySink | null = null;
  /** When set, receives every key press instead of the sink (used while rebinding). */
  capture: ((code: string) => void) | null = null;
  enabled = true;
  private down = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
    if (this.capture) {
      e.preventDefault();
      if (!e.repeat) this.capture(e.code);
      return;
    }
    if (!this.enabled || !this.sink) return;
    if (this.sink.keyDown(e.code)) e.preventDefault();
  };
  private up = (e: KeyboardEvent) => {
    if (!this.sink) return;
    if (this.sink.keyUp(e.code)) e.preventDefault();
  };
  private blur = () => this.releaseAll?.();
  releaseAll: (() => void) | null = null;

  constructor() {
    window.addEventListener('keydown', this.down);
    window.addEventListener('keyup', this.up);
    window.addEventListener('blur', this.blur);
  }

  attach(sink: KeySink, releaseAll: () => void): void {
    this.sink = sink;
    this.releaseAll = releaseAll;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.down);
    window.removeEventListener('keyup', this.up);
    window.removeEventListener('blur', this.blur);
  }
}
