import type { AircraftData } from '../data/aircraft';
import { TUNING } from '../data/tuning';
import { KTS } from '../sim/math';
import { Warn, type EngineState, type Telemetry } from '../sim/types';
import type { Helipad } from '../world/structures';
import type { WorkerPool } from '../world/workerPool';
import type { World } from '../world/world';
import { el } from './menu';
import { Minimap } from './minimap';

/** Everything the HUD shows, gathered by the game each frame. */
export interface HudState {
  tel: Telemetry;
  aircraft: AircraftData;
  engine: EngineState;
  autohoverEngaged: boolean;
  autohoverActive: boolean;
  destroyed: boolean;
  destroyedReason: string;
  brake: boolean;
  x: number;
  z: number;
  lastPad: { x: number; z: number } | null;
  hour: number;
  /** Weather label, preset id, and the label it is changing from (null when settled). */
  weather: string;
  weatherId: string;
  weatherLeaving: string | null;
  /** 0 at night, 1 in full daylight. */
  daylight: number;
  nightVision: boolean;
  windX: number;
  windZ: number;
  turbulence: number;
  seed: string;
  /** The mouse is captured for looking around. */
  mouseLook: boolean;
  /** Combat warnings, most urgent first: [class, text]. */
  combat?: [string, string][];
}

export interface HudActions {
  respawn(): void;
  menu(): void;
  /** Current key label for each action, for the hints. */
  keys(): Record<string, string>;
}

const C = {
  text: '#f3f5f8',
  dim: 'rgba(236,240,246,0.64)',
  faint: 'rgba(236,240,246,0.22)',
  accent: '#64d2ff',
  ok: '#30d158',
  warn: '#ffd60a',
  danger: '#ff453a',
};

/** Warnings in priority order: bit, text, severity. */
const WARNINGS: [number, string, 'warning' | 'caution'][] = [
  [Warn.EngineOut, 'Engine out', 'warning'],
  [Warn.SinkRate, 'Sink rate', 'warning'],
  [Warn.TailRotor, 'Tail rotor failure', 'warning'],
  [Warn.Damage, 'Damage', 'caution'],
  [Warn.LowFuel, 'Low fuel', 'caution'],
  [Warn.LowerCollective, 'Lower collective to start', 'caution'],
];

function hidpi(w: number, h: number, cls: string): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const c = el('canvas', { class: cls });
  c.width = w * dpr;
  c.height = h * dpr;
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [c, ctx];
}

const pad2 = (n: number) => String(Math.floor(n)).padStart(2, '0');

/** What part of the day an hour falls in. */
function dayPhase(h: number): string {
  if (h >= 5 && h < 7) return 'Dawn';
  if (h >= 7 && h < 11) return 'Morning';
  if (h >= 11 && h < 13.5) return 'Midday';
  if (h >= 13.5 && h < 17) return 'Afternoon';
  if (h >= 17 && h < 19) return 'Dusk';
  if (h >= 19 && h < 22) return 'Evening';
  return 'Night';
}

/** Weather glyphs, 20 × 20, stroked in the current colour. */
const CLOUD = '<path d="M6.2 15.5h8.3a3.2 3.2 0 0 0 .3-6.4 4.6 4.6 0 0 0-8.8 1.2 2.6 2.6 0 0 0 .2 5.2z"/>';
const SUN = '<circle cx="10" cy="10" r="3.4"/><path d="M10 2.6v1.8M10 15.6v1.8M2.6 10h1.8M15.6 10h1.8M4.8 4.8l1.3 1.3M13.9 13.9l1.3 1.3M4.8 15.2l1.3-1.3M13.9 6.1l1.3-1.3"/>';
const MOON = '<path d="M14.6 12.9A6 6 0 0 1 7.1 5.4a6 6 0 1 0 7.5 7.5z"/>';
const RAISED = (body: string) => `<g transform="translate(0 -2.5)">${body}</g>`;
const ICONS: Record<string, (night: boolean) => string> = {
  clear: (n) => (n ? MOON : SUN),
  fair: (n) => `<g transform="translate(3.2 -3.2) scale(0.62)">${n ? MOON : SUN}</g>${CLOUD}`,
  gale: () => '<path d="M2.5 7.5h9.2a2.3 2.3 0 1 0-2.3-2.3M2.5 11h12.8a2.3 2.3 0 1 1-2.3 2.3M2.5 14.5h6"/>',
  mist: () => '<path d="M3 7h14M5 10.5h12M3 14h11"/>',
  fog: () => '<path d="M3 5.5h14M3 9h14M3 12.5h14M5 16h10"/>',
  overcast: () => `<path d="M8.6 6.6a3.6 3.6 0 0 1 6.6 1.4 2.5 2.5 0 0 1 .4 5" opacity="0.55"/>${CLOUD}`,
  showers: (n) => `${RAISED(`<g transform="translate(3.2 -3.2) scale(0.62)">${n ? MOON : SUN}</g>${CLOUD}`)}<path d="M8 15.8l-.7 1.8M12 15.8l-.7 1.8"/>`,
  rain: () => `${RAISED(CLOUD)}<path d="M6.8 15.6l-.8 2M10 15.6l-.8 2M13.2 15.6l-.8 2"/>`,
  storm: () => `${RAISED(CLOUD)}<path d="M10.6 13.2l-2 3.2h2.6l-1.6 2.8"/>`,
  snow: () => `${RAISED(CLOUD)}<path d="M7 16.4h.01M10 17.6h.01M13 16.4h.01" stroke-width="2.4"/>`,
};

/** Flight instruments, engine gauges, warnings, minimap and the crash banner. */
export class Hud {
  readonly minimap: Minimap;
  private att: CanvasRenderingContext2D;
  private tape: CanvasRenderingContext2D;
  private gauges: CanvasRenderingContext2D;
  private ias = el('div', { class: 'big num' });
  private gs = el('div', { class: 'small num' });
  private alt = el('div', { class: 'big num' });
  private rad = el('div', { class: 'small num' });
  private vs = el('div', { class: 'small num' });
  private info = el('div', { class: 'hud-seed hud-panel' });
  private sky = el('div', { class: 'hud-sky hud-panel', role: 'status', 'aria-label': 'Time and weather' });
  private dial: CanvasRenderingContext2D;
  private skyClock = el('div', { class: 'clock num' });
  private skyPhase = el('div', { class: 'phase' });
  private wxIcon = el('span', { class: 'wx-icon', 'aria-hidden': 'true' });
  private wxLabel = el('span', { class: 'wx-label' });
  private wxSub = el('div', { class: 'wx-sub num' });
  private nvg = el('div', { class: 'nvg-chip' }, 'NVG');
  private lastSky = '';
  private lastIcon = '';
  private hint = el('div', { class: 'hud-hint hud-panel' });
  private mapCap = el('div', { class: 'cap' });
  private pills = el('div', { class: 'pills', 'aria-live': 'polite' });
  private banner: HTMLElement;
  private bannerReason = el('p', {});
  private lastPills = '';
  private lastInfo = '';
  private lastHint = '';
  private lastCap = -1;
  private frame = 0;
  private blink = 0;

  constructor(root: HTMLElement, world: World, pool: WorkerPool, helipads: (x: number, z: number, r: number) => Helipad[], private actions: HudActions) {
    const [attC, att] = hidpi(150, 150, 'adi');
    const [tapeC, tape] = hidpi(320, 30, 'tape');
    const [gC, g] = hidpi(204, 128, 'gauges');
    this.att = att;
    this.tape = tape;
    this.gauges = g;
    this.minimap = new Minimap(world, pool, helipads, 196);
    const [dialC, dial] = hidpi(38, 38, 'dial');
    this.dial = dial;
    this.sky.append(
      dialC,
      el('div', { class: 'sky-time' }, this.skyClock, this.skyPhase),
      el('div', { class: 'sky-sep' }),
      el('div', { class: 'sky-wx' }, el('div', { class: 'wx-row' }, this.wxIcon, this.wxLabel), this.wxSub),
      this.nvg,
    );

    const col = (cls: string, label: string, big: HTMLElement, ...rest: HTMLElement[]) =>
      el('div', { class: `col ${cls}` }, el('div', { class: 'label' }, label), big, ...rest);
    this.banner = el('div', { class: 'banner glass', role: 'alertdialog', 'aria-label': 'Aircraft destroyed' },
      el('h2', {}, 'Aircraft destroyed'),
      this.bannerReason,
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', onclick: () => actions.respawn() }, 'Respawn'),
        el('button', { class: 'btn', onclick: () => actions.menu() }, 'Menu'),
      ),
    );
    this.banner.style.display = 'none';
    root.append(
      this.sky,
      this.info,
      el('div', { class: 'hud-top hud-panel' }, tapeC),
      this.pills,
      el('div', { class: 'hud-flight hud-panel' },
        col('left', 'IAS kt', this.ias, this.gs),
        attC,
        col('right', 'ALT m', this.alt, this.rad, this.vs),
      ),
      el('div', { class: 'hud-engine hud-panel' }, gC),
      el('div', { class: 'hud-map hud-panel' }, this.minimap.canvas, this.mapCap),
      this.hint,
      this.banner,
    );
  }

  update(s: HudState, dt: number): void {
    this.frame++;
    this.blink = (this.blink + dt) % 1;
    const t = s.tel;
    this.drawAttitude(t);
    this.drawTape(t.heading);
    if (this.frame % 2 === 0) this.drawGauges(s);
    if (this.frame % 3 === 0) {
      this.ias.textContent = `${Math.round(t.airspeed / KTS)}`;
      this.gs.textContent = `GS ${Math.round(t.groundSpeed / KTS)}`;
      this.alt.textContent = `${Math.round(t.baroAlt)}`;
      this.rad.textContent = t.radarAlt < 450 ? `RAD ${t.radarAlt < 10 ? t.radarAlt.toFixed(1) : Math.round(t.radarAlt)}` : 'RAD —';
      const vs = t.verticalSpeed;
      this.vs.textContent = `${vs > 0.05 ? '▲' : vs < -0.05 ? '▼' : '◆'} ${Math.abs(vs).toFixed(1)} m/s`;
      this.vs.classList.toggle('alert', vs < -5 && t.radarAlt < 60);
    }
    if (this.frame % 6 === 0) {
      this.minimap.draw(s.x, s.z, t.heading, s.lastPad, { x: s.windX, z: s.windZ });
      if (this.lastCap !== this.minimap.zoom) {
        this.lastCap = this.minimap.zoom;
        this.mapCap.replaceChildren(el('span', { class: 'num' }, `${((this.minimap.radius * 2) / 1000).toFixed(1)} km`), el('span', {}, `${this.actions.keys().toggleMap} zoom`));
      }
      this.updateText(s);
    }
    this.updatePills(s);
    this.banner.style.display = s.destroyed ? '' : 'none';
    if (s.destroyed) this.bannerReason.textContent = `${s.destroyedReason || 'Crashed'}. Respawn at the last helipad, or pick another start.`;
  }

  private updateText(s: HudState): void {
    const wind = Math.hypot(s.windX, s.windZ);
    // Direction the wind blows from, in compass degrees (north = −z, east = +x).
    const from = ((Math.atan2(-s.windX, s.windZ) * 180) / Math.PI + 360) % 360;
    const clock = `${pad2(s.hour)}:${pad2((s.hour % 1) * 60)}`;
    const windText = wind < 0.5 ? 'Calm' : `Wind ${String(Math.round(from / 10) * 10 || 360).padStart(3, '0')}° ${Math.round(wind / KTS)} kt${s.turbulence > 1.5 ? ' · gusty' : ''}`;
    if (s.seed !== this.lastInfo) {
      this.lastInfo = s.seed;
      this.info.replaceChildren(el('span', {}, 'Seed'), el('b', {}, s.seed));
    }
    this.updateSky(s, clock, windText);
    const k = this.actions.keys();
    let hint: [string, string][];
    if (s.destroyed) hint = [[k.respawn, 'Respawn'], [k.pause, 'Menu']];
    else if (s.engine === 'off' && s.tel.rotorRpm < 0.05) hint = [[k.engineToggle, 'Start engine'], [k.toggleControls, 'Controls']];
    else if (s.engine === 'starting') hint = [['', 'Rotor spooling up, wait for the green']];
    else if (s.tel.onGround && s.tel.rotorRpm >= TUNING.engine.greenMin) hint = [[k.collectiveUp, 'Raise collective to lift off'], [k.autohoverToggle, 'Autohover']];
    else if (!s.mouseLook) hint = [['Click', 'Look around'], [k.cameraNext, 'Camera'], [k.toggleControls, 'Controls']];
    else hint = [[k.freeLook, 'Centre view'], [k.cameraNext, 'Camera'], [k.toggleControls, 'Controls']];
    const hs = JSON.stringify(hint);
    if (hs !== this.lastHint) {
      this.lastHint = hs;
      const parts: HTMLElement[] = [];
      hint.forEach(([key, text], i) => {
        if (i > 0) parts.push(el('span', { class: 'sep' }, '·'));
        if (key) parts.push(el('kbd', {}, key));
        parts.push(el('span', {}, text));
      });
      this.hint.replaceChildren(...parts);
    }
  }

  /** The time and weather card: a sun/moon dial, the clock, and the weather with its wind. */
  private updateSky(s: HudState, clock: string, windText: string): void {
    this.drawDial(s.hour, s.daylight);
    const night = s.daylight < 0.3;
    const label = s.weatherLeaving ? `${s.weatherLeaving} → ${s.weather}` : s.weather;
    const key = `${clock}|${label}|${windText}|${s.nightVision}`;
    if (key !== this.lastSky) {
      this.lastSky = key;
      this.skyClock.textContent = clock;
      this.skyPhase.textContent = dayPhase(s.hour);
      this.wxLabel.textContent = label;
      this.wxSub.textContent = windText;
      this.nvg.classList.toggle('on', s.nightVision);
      this.sky.classList.toggle('changing', s.weatherLeaving !== null);
    }
    const icon = `${s.weatherId}|${night}`;
    if (icon !== this.lastIcon) {
      this.lastIcon = icon;
      const glyph = (ICONS[s.weatherId] ?? ICONS.fair)(night);
      this.wxIcon.innerHTML = `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg>`;
    }
  }

  /** Sky dial: the sun rises on the left at 06:00, peaks at noon and sets on the right; the moon rides opposite. */
  private drawDial(hour: number, daylight: number): void {
    const c = this.dial, S = 38, cx = S / 2, cy = S / 2, r = S / 2 - 2;
    c.clearRect(0, 0, S, S);
    c.save();
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.clip();
    // Sky above the horizon, from deep night to day blue; ground below.
    const d = Math.max(0, Math.min(1, daylight));
    const dusk = Math.max(0, 1 - Math.abs(daylight - 0.35) / 0.25);
    c.fillStyle = `rgb(${Math.round(14 + 70 * d + 120 * dusk)}, ${Math.round(20 + 120 * d + 40 * dusk)}, ${Math.round(40 + 170 * d)})`;
    c.fillRect(0, 0, S, cy);
    c.fillStyle = 'rgba(255,255,255,0.06)';
    c.fillRect(0, cy, S, S - cy);
    c.restore();
    c.strokeStyle = 'rgba(255,255,255,0.22)';
    c.lineWidth = 1;
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.moveTo(cx - r, cy);
    c.lineTo(cx + r, cy);
    c.stroke();
    const a = (Math.PI * (hour - 6)) / 12;
    const track = r - 6;
    const body = (ang: number, col: string, rad: number) => {
      const x = cx - Math.cos(ang) * track, y = cy - Math.sin(ang) * track;
      if (y > cy + rad) return;
      c.fillStyle = col;
      c.beginPath();
      c.arc(x, y, rad, 0, Math.PI * 2);
      c.fill();
    };
    body(a + Math.PI, 'rgba(226,232,246,0.92)', 3);
    body(a, '#ffd60a', 4);
  }

  private updatePills(s: HudState): void {
    const items: [string, string][] = s.destroyed ? [] : [...(s.combat ?? [])];
    if (s.autohoverEngaged) items.push([s.autohoverActive ? 'autohover' : 'autohover standby', s.autohoverActive ? 'Autohover' : 'Autohover standby']);
    const w = s.tel.warnings;
    let n = 0;
    for (const [bit, text, sev] of WARNINGS) {
      if (w & bit && n < 3 && !s.destroyed) {
        items.push([sev, text]);
        n++;
      }
    }
    if (s.engine === 'starting' && !(w & Warn.LowerCollective)) items.push(['info', `Engine start · NR ${Math.round(s.tel.rotorRpm * 100)}%`]);
    if (s.brake && s.tel.onGround && s.aircraft.gear.type === 'wheels' && s.engine === 'running') items.push(['info', 'Wheel brake']);
    const key = items.map((i) => i.join(':')).join('|');
    if (key !== this.lastPills) {
      this.lastPills = key;
      this.pills.replaceChildren(...items.map(([cls, text]) => el('div', { class: `pill ${cls}` }, text)));
    }
  }

  private drawAttitude(t: Telemetry): void {
    const c = this.att, S = 150, r = S / 2 - 4;
    c.clearRect(0, 0, S, S);
    c.save();
    c.translate(S / 2, S / 2);
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.clip();
    // Horizon: roll turns it, pitch moves it.
    const ppd = 2.6;
    const pitch = (t.pitch * 180) / Math.PI;
    c.rotate(-t.roll);
    const y = pitch * ppd;
    const sky = c.createLinearGradient(0, -r * 2, 0, y);
    sky.addColorStop(0, '#1d4f86');
    sky.addColorStop(1, '#4f8fc9');
    c.fillStyle = sky;
    c.fillRect(-r * 2, -r * 4, r * 4, r * 4 + y);
    const gr = c.createLinearGradient(0, y, 0, y + r * 2);
    gr.addColorStop(0, '#7a5530');
    gr.addColorStop(1, '#3f2a17');
    c.fillStyle = gr;
    c.fillRect(-r * 2, y, r * 4, r * 4);
    c.strokeStyle = '#fff';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(-r * 2, y);
    c.lineTo(r * 2, y);
    c.stroke();
    // Pitch ladder every 10°, short marks every 5°.
    c.font = '600 9px -apple-system, system-ui, sans-serif';
    c.fillStyle = '#fff';
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    c.lineWidth = 1.2;
    for (let p = -80; p <= 80; p += 5) {
      if (p === 0) continue;
      const yy = y - p * ppd;
      if (Math.abs(yy) > r) continue;
      const w = p % 10 === 0 ? 22 : 10;
      c.beginPath();
      c.moveTo(-w, yy);
      c.lineTo(w, yy);
      c.stroke();
      if (p % 10 === 0) c.fillText(String(Math.abs(p)), -w - 3, yy);
    }
    c.restore();

    // Bank scale (fixed to the case) and the bank pointer (turns with the horizon).
    c.save();
    c.translate(S / 2, S / 2);
    c.strokeStyle = 'rgba(255,255,255,0.85)';
    c.lineWidth = 1.5;
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const rad = ((a - 90) * Math.PI) / 180;
      const l = a % 30 === 0 ? 9 : 5;
      c.beginPath();
      c.moveTo(Math.cos(rad) * (r - 1), Math.sin(rad) * (r - 1));
      c.lineTo(Math.cos(rad) * (r - 1 - l), Math.sin(rad) * (r - 1 - l));
      c.stroke();
    }
    c.rotate(-t.roll);
    c.fillStyle = C.warn;
    c.beginPath();
    c.moveTo(0, -r + 11);
    c.lineTo(-5, -r + 19);
    c.lineTo(5, -r + 19);
    c.closePath();
    c.fill();
    c.restore();

    // Aircraft symbol, and a yaw-rate bar where a slip ball would be.
    c.save();
    c.translate(S / 2, S / 2);
    c.strokeStyle = C.warn;
    c.lineWidth = 3;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(-34, 0);
    c.lineTo(-12, 0);
    c.lineTo(-6, 6);
    c.moveTo(34, 0);
    c.lineTo(12, 0);
    c.lineTo(6, 6);
    c.stroke();
    c.fillStyle = C.warn;
    c.beginPath();
    c.arc(0, 0, 2.5, 0, Math.PI * 2);
    c.fill();
    const yr = Math.max(-1, Math.min(1, t.yawRate / 0.6));
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.fillRect(-30, r - 16, 60, 5);
    c.fillStyle = '#fff';
    c.fillRect(yr * 27 - 3, r - 17, 6, 7);
    c.restore();
    c.strokeStyle = 'rgba(255,255,255,0.25)';
    c.lineWidth = 1;
    c.beginPath();
    c.arc(S / 2, S / 2, r, 0, Math.PI * 2);
    c.stroke();
  }

  private drawTape(heading: number): void {
    const c = this.tape, W = 320, H = 30;
    c.clearRect(0, 0, W, H);
    const deg = (heading * 180) / Math.PI;
    const ppd = 3.2;
    c.font = '600 11px -apple-system, system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    c.strokeStyle = C.dim;
    c.lineWidth = 1;
    const names: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let d = Math.ceil((deg - 55) / 5) * 5; d <= deg + 55; d += 5) {
      const x = W / 2 + (d - deg) * ppd;
      const fade = 1 - Math.min(1, Math.abs(x - W / 2) / (W / 2));
      const dn = ((d % 360) + 360) % 360;
      c.globalAlpha = 0.2 + 0.8 * fade;
      c.beginPath();
      c.moveTo(x, H - 2);
      c.lineTo(x, H - (dn % 10 === 0 ? 9 : 5));
      c.stroke();
      if ((names[dn] || dn % 30 === 0) && Math.abs(x - W / 2) > 24) {
        c.fillStyle = names[dn] ? C.text : C.dim;
        c.fillText(names[dn] ?? String(dn / 10), x, 13);
      }
    }
    c.globalAlpha = 1;
    c.fillStyle = 'rgba(10,12,16,0.85)';
    c.beginPath();
    c.roundRect(W / 2 - 21, 0, 42, 17, 5);
    c.fill();
    c.fillStyle = C.text;
    c.font = '700 12px ui-monospace, "SF Mono", Menlo, monospace';
    c.fillText(String(Math.round(deg) % 360).padStart(3, '0'), W / 2, 13);
    c.fillStyle = C.accent;
    c.beginPath();
    c.moveTo(W / 2, H - 1);
    c.lineTo(W / 2 - 4, H - 7);
    c.lineTo(W / 2 + 4, H - 7);
    c.closePath();
    c.fill();
  }

  private drawGauges(s: HudState): void {
    const c = this.gauges, W = 204, H = 128;
    c.clearRect(0, 0, W, H);
    const t = s.tel;
    const E = TUNING.engine;
    const top = 6, h = 74, bw = 14;
    const bar = (i: number, label: string, value: number, max: number, text: string, color: string, bands: [number, number, string][], marks: number[] = []) => {
      const x = 12 + i * 50;
      c.fillStyle = 'rgba(255,255,255,0.08)';
      c.beginPath();
      c.roundRect(x, top, bw, h, 4);
      c.fill();
      for (const [a, b, col] of bands) {
        const y0 = top + h - (Math.min(b, max) / max) * h, y1 = top + h - (Math.min(a, max) / max) * h;
        c.fillStyle = col;
        c.fillRect(x + bw + 2, y0, 3, y1 - y0);
      }
      const v = Math.max(0, Math.min(1, value / max));
      c.fillStyle = color;
      c.beginPath();
      c.roundRect(x, top + h - v * h, bw, Math.max(2, v * h), 4);
      c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.7)';
      c.lineWidth = 1;
      for (const m of marks) {
        const y = top + h - (m / max) * h;
        c.beginPath();
        c.moveTo(x - 2, y);
        c.lineTo(x + bw + 2, y);
        c.stroke();
      }
      c.textAlign = 'center';
      c.fillStyle = C.dim;
      c.font = '600 9px -apple-system, system-ui, sans-serif';
      c.fillText(label, x + bw / 2 + 2, top + h + 12);
      c.fillStyle = color === C.danger || color === C.warn ? color : C.text;
      c.font = '600 11px -apple-system, system-ui, sans-serif';
      c.fillText(text, x + bw / 2 + 2, top + h + 26);
    };
    const nr = t.rotorRpm * 100;
    const inGreen = t.rotorRpm >= E.greenMin && t.rotorRpm <= E.greenMax;
    const nrCol = inGreen ? C.ok : t.rotorRpm > E.greenMax ? C.danger : s.engine === 'starting' ? C.accent : t.rotorRpm > 0.05 ? C.warn : C.faint;
    bar(0, 'NR', nr, 115, `${Math.round(nr)}%`, nrCol, [[E.greenMin * 100, E.greenMax * 100, C.ok], [E.greenMax * 100, 115, C.danger]]);
    const tq = t.torque * 100;
    // Torque is information only: there is no limit to exceed.
    bar(1, 'TQ', tq, 130, `${Math.round(tq)}%`, C.accent, [], [100]);
    bar(2, 'COLL', t.collective * 100, 100, `${Math.round(t.collective * 100)}%`, '#e6e9ee', []);
    const low = t.fuelFraction < 0.12;
    bar(3, 'FUEL', t.fuelFraction * 100, 100, `${Math.round(t.fuel)} kg`, low ? (this.blink < 0.5 ? C.danger : C.warn) : '#c9ced6', [[0, 12, C.danger]]);

    // Engine state and airframe health along the bottom.
    const state = s.destroyed ? 'DESTROYED' : s.engine === 'running' ? 'ENGINE RUNNING' : s.engine === 'starting' ? 'ENGINE START' : s.engine === 'failed' ? 'ENGINE FAILED' : 'ENGINE OFF';
    const stCol = s.destroyed || s.engine === 'failed' ? C.danger : s.engine === 'running' ? C.ok : s.engine === 'starting' ? C.accent : C.dim;
    c.textAlign = 'left';
    c.font = '700 9px -apple-system, system-ui, sans-serif';
    c.fillStyle = stCol;
    c.fillText(state, 4, H - 4);
    const hw = 54, hx = W - hw - 4;
    c.fillStyle = 'rgba(255,255,255,0.1)';
    c.fillRect(hx, H - 10, hw, 5);
    c.fillStyle = t.health > 0.6 ? C.ok : t.health > 0.3 ? C.warn : C.danger;
    c.fillRect(hx, H - 10, hw * Math.max(0, t.health), 5);
    c.textAlign = 'right';
    c.fillStyle = C.dim;
    c.fillText('AIRFRAME', hx - 5, H - 4);
  }
}
