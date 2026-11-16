import { ACTION_LABELS, DEFAULT_BINDINGS, type Action } from '../data/controls';
import { keyLabel } from '../game/settings';
import { el } from './menu';

const GROUPS: [string, Action[]][] = [
  ['Flight', ['collectiveUp', 'collectiveDown', 'pitchDown', 'pitchUp', 'rollLeft', 'rollRight', 'yawLeft', 'yawRight']],
  ['Systems', ['engineToggle', 'autohoverToggle', 'wheelBrake', 'landingLight']],
  ['View', ['cameraNext', 'freeLook', 'toggleMap']],
  ['Game', ['toggleControls', 'respawn', 'pause']],
];

export interface ControlsHost {
  bindings(): Record<Action, string[]>;
  setBindings(b: Record<Action, string[]>): void;
  /** Route the next key press to a callback instead of the game; null to stop. */
  capture(fn: ((code: string) => void) | null): void;
  onOpenChange(open: boolean): void;
}

/**
 * The controls overlay: every binding, grouped, with click-to-rebind.
 * A rebound key is taken away from any other action that used it.
 */
export class ControlsOverlay {
  isOpen = false;
  private scrim: HTMLElement;
  private grid = el('div', { class: 'binds' });
  private listening: Action | null = null;

  constructor(root: HTMLElement, private host: ControlsHost) {
    const sheet = el('div', { class: 'sheet glass', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Controls' },
      el('h2', {}, 'Controls'),
      el('p', { class: 'lede' }, 'No key moves the helicopter directly. Collective sets thrust, cyclic tilts it, and the motion comes from where the thrust points. Click a key to rebind it.'),
      el('div', { class: 'scroll' }, this.grid),
      el('div', { class: 'foot' },
        el('span', { class: 'tip' }, 'Drag the mouse to look around'),
        el('button', { class: 'btn', onclick: () => this.reset() }, 'Reset to defaults'),
        el('button', { class: 'btn primary', onclick: () => this.close() }, 'Done'),
      ),
    );
    this.scrim = el('div', { class: 'scrim' }, sheet);
    this.scrim.addEventListener('pointerdown', (e) => {
      if (e.target === this.scrim) this.close();
    });
    root.append(this.scrim);
    this.render();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.render();
    this.scrim.classList.add('open');
    this.host.onOpenChange(true);
  }

  close(): void {
    if (!this.isOpen) return;
    this.stopListening();
    this.isOpen = false;
    this.scrim.classList.remove('open');
    this.host.onOpenChange(false);
  }

  private reset(): void {
    this.stopListening();
    this.host.setBindings(structuredClone(DEFAULT_BINDINGS));
    this.render();
  }

  private stopListening(): void {
    this.listening = null;
    this.host.capture(null);
  }

  private listen(action: Action): void {
    this.listening = action;
    this.render();
    this.host.capture((code) => {
      this.host.capture(null);
      this.listening = null;
      if (code !== 'Escape') {
        const b = structuredClone(this.host.bindings());
        for (const a of Object.keys(b) as Action[]) b[a] = b[a].filter((c) => c !== code);
        b[action] = [code];
        this.host.setBindings(b);
      }
      this.render();
    });
  }

  private render(): void {
    const b = this.host.bindings();
    const rows: HTMLElement[] = [];
    for (const [title, actions] of GROUPS) {
      rows.push(el('div', { class: 'label group-title' }, title));
      for (const a of actions) {
        const listening = this.listening === a;
        const keys = b[a].length ? b[a].map(keyLabel).join(' / ') : '—';
        rows.push(
          el('div', { class: 'bind' },
            el('span', {}, ACTION_LABELS[a]),
            el('button', {
              class: listening ? 'listening' : '',
              'aria-label': `${ACTION_LABELS[a]}: ${keys}. Click to change.`,
              onclick: () => (listening ? this.stopListening() : this.listen(a)),
            }, listening ? 'Press a key' : keys),
          ),
        );
      }
    }
    this.grid.replaceChildren(...rows);
  }
}
