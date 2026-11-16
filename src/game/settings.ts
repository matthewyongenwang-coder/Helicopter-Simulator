import { DEFAULT_BINDINGS, type Action } from '../data/controls';
import type { QualityName } from '../data/graphics';

export interface Settings {
  quality: QualityName;
  bindings: Record<Action, string[]>;
  /** Master volume 0–1. */
  volume: number;
  aircraft: string;
  /** Fuel load as a fraction of capacity, and payload as a fraction of the room left under max takeoff weight. */
  fuel: number;
  payload: number;
  /** Time of day in hours, or −1 to let it run from mid-morning. */
  hour: number;
  weather: string;
}

const KEY = 'helisim.settings.v1';

export function defaultSettings(): Settings {
  return {
    quality: 'medium',
    bindings: structuredClone(DEFAULT_BINDINGS),
    volume: 0.7,
    aircraft: 'medium',
    fuel: 1,
    payload: 0.25,
    hour: -1,
    weather: 'auto',
  };
}

/** Read saved settings, falling back to defaults for anything missing or malformed. */
export function loadSettings(): Settings {
  const s = defaultSettings();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (raw.quality === 'low' || raw.quality === 'medium' || raw.quality === 'high') s.quality = raw.quality;
    if (typeof raw.volume === 'number') s.volume = Math.min(1, Math.max(0, raw.volume));
    if (typeof raw.aircraft === 'string') s.aircraft = raw.aircraft;
    if (typeof raw.fuel === 'number') s.fuel = Math.min(1, Math.max(0.1, raw.fuel));
    if (typeof raw.payload === 'number') s.payload = Math.min(1, Math.max(0, raw.payload));
    if (typeof raw.hour === 'number') s.hour = raw.hour;
    if (typeof raw.weather === 'string') s.weather = raw.weather;
    if (raw.bindings && typeof raw.bindings === 'object') {
      for (const a of Object.keys(s.bindings) as Action[]) {
        const b = raw.bindings[a];
        if (Array.isArray(b) && b.every((c) => typeof c === 'string')) s.bindings[a] = b;
      }
    }
  } catch {
    // Unreadable or blocked storage: defaults are fine.
  }
  return s;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private windows may refuse: the game still works, it just forgets.
  }
}

/** Short label for a KeyboardEvent.code, e.g. "KeyW" → "W", "ShiftLeft" → "Shift". */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return { Up: '↑', Down: '↓', Left: '←', Right: '→' }[code.slice(5)] ?? code;
  const map: Record<string, string> = {
    Space: 'Space', ShiftLeft: 'Shift', ShiftRight: 'R Shift', ControlLeft: 'Ctrl', ControlRight: 'R Ctrl', AltLeft: 'Alt', AltRight: 'R Alt',
    Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backquote: '`', Minus: '−', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backspace: '⌫',
  };
  return map[code] ?? code;
}
