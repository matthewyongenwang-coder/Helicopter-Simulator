import { AIRCRAFT, AIRCRAFT_ORDER } from '../data/aircraft';
import { armamentText } from '../data/weapons';
import { GRAPHICS, type QualityName } from '../data/graphics';
import { WEATHER, WEATHER_ORDER } from '../data/weather';
import type { Settings } from '../game/settings';
import { deriveAircraft } from '../sim/derive';
import { KTS } from '../sim/math';
import { seedToString } from '../world/rng';
import type { Helipad } from '../world/structures';

/** Tiny DOM builder: el('div', { class: 'x' }, child, 'text'). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | ((e: Event) => void)> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') n.addEventListener(k.replace(/^on/, ''), v);
    else if (k === 'class') n.className = String(v);
    else n.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}

export interface MenuHost {
  seed: number;
  settings: Settings;
  /** Helipads near the start area, nearest first. */
  helipads(): Helipad[];
  /** Park the chosen aircraft at the chosen place so it shows behind the menu. */
  preview(aircraft: string, pad: Helipad | null): void;
  fly(aircraft: string, pad: Helipad | null): void;
  /** Close the menu and carry on with the flight in progress. */
  resume(): void;
  /** Reload with a new seed; null picks a random one. */
  reseed(seed: string | null): void;
  setQuality(q: QualityName): void;
  openControls(): void;
  saveSettings(): void;
  setWeather(id: string): void;
  /** Start hour, or −1 for the default morning start. */
  setHour(hour: number): void;
  setVolume(v: number): void;
  /** A multiplayer relay is configured for this build. */
  netAvailable: boolean;
  /** Join the room for this world seed, or leave it. */
  goOnline(): void;
  goOffline(): void;
  /** Copy a link that opens this world, online. */
  copyInvite(): void;
  /** The callsign changed (reconnect if online, so others see it). */
  setCallsign(name: string): void;
}

const TIMES: [string, number][] = [
  ['Morning', -1],
  ['Dawn', 6.2],
  ['Noon', 12],
  ['Afternoon', 15.5],
  ['Dusk', 18.6],
  ['Night', 22.5],
];

const fmt = (v: number, digits = 0) => v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });

/** Rows of the comparison table: label and a formatter per aircraft id. */
const SPEC_ROWS: [string, (id: string) => string][] = [
  ['Role', (id) => AIRCRAFT[id].role],
  ['Empty mass', (id) => `${fmt(AIRCRAFT[id].mass.empty)} kg`],
  ['Max takeoff', (id) => `${fmt(AIRCRAFT[id].mass.maxTakeoff)} kg`],
  ['Rotor', (id) => `${fmt(AIRCRAFT[id].rotor.diameter, 1)} m × ${AIRCRAFT[id].rotor.blades}`],
  ['Power', (id) => `${fmt(AIRCRAFT[id].engine.powerKW)} kW`],
  ['Top speed', (id) => `${fmt(AIRCRAFT[id].perf.topSpeedKts)} kt`],
  ['Climb rate', (id) => `${fmt(deriveAircraft(AIRCRAFT[id]).computed.maxClimb, 1)} m/s`],
  ['Hover ceiling', (id) => `${fmt(Math.round(deriveAircraft(AIRCRAFT[id]).computed.hoverCeiling / 50) * 50)} m`],
  ['Tilt rate', (id) => `${AIRCRAFT[id].handling.pitchRate} / ${AIRCRAFT[id].handling.rollRate} °/s`],
  ['Yaw rate', (id) => `${AIRCRAFT[id].handling.yawRate} °/s`],
  ['Fuel', (id) => `${fmt(AIRCRAFT[id].fuel.capacity)} kg`],
  ['Burn', (id) => `${fmt(AIRCRAFT[id].fuel.burnRated)} kg/h`],
  ['Range', (id) => `${fmt(Math.round(deriveAircraft(AIRCRAFT[id]).computed.range / 10) * 10)} km`],
  ['Hard landing limit', (id) => `${fmt(AIRCRAFT[id].damage.hardLanding, 1)} m/s`],
  ['Gear', (id) => (AIRCRAFT[id].gear.type === 'skids' ? 'Skids' : 'Wheels')],
  ['Armament', (id) => armamentText(id)],
];

/** Rows whose text wraps inside its cell. */
const WRAP_ROWS = new Set(['Role', 'Armament']);

/** The spawn menu: pick an aircraft, a place to start, a load, and fly. */
export class Menu {
  isOpen = false;
  private aircraft: string;
  private pad: Helipad | null = null;
  private pads: Helipad[] = [];
  private listAircraft = el('div', { class: 'rows', role: 'listbox', 'aria-label': 'Aircraft' });
  private listPads = el('div', { class: 'rows', role: 'listbox', 'aria-label': 'Start location' });
  private specs = el('div', { class: 'specs glass' });
  private side = el('div', { class: 'side glass' });
  private flyBtn = el('button', { class: 'btn primary wide', onclick: () => this.host.fly(this.aircraft, this.pad) }, 'Fly');
  private resumeBtn = el('button', { class: 'btn wide', onclick: () => this.host.resume() }, 'Resume flight');
  /** A flight is in progress behind the menu; picking anything else replaces it. */
  private resumable = false;
  private netStatus = el('p', { class: 'net-status', 'aria-live': 'polite' });
  private netBtn = el('button', { class: 'btn', onclick: () => (this.netOnline ? this.host.goOffline() : this.host.goOnline()) }, 'Play online');
  private inviteBtn = el('button', { class: 'btn', onclick: () => this.host.copyInvite() }, 'Copy invite link');
  private netOnline = false;

  constructor(private root: HTMLElement, private host: MenuHost) {
    this.aircraft = Object.hasOwn(AIRCRAFT, host.settings.aircraft) ? host.settings.aircraft : 'medium';
    const s = host.settings;

    const seedInput = el('input', { value: seedToString(host.seed), spellcheck: false, 'aria-label': 'World seed', maxlength: 24 });
    seedInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') host.reseed(seedInput.value);
    });

    const range = (label: string, get: () => number, set: (v: number) => void, show: (v: number) => string) => {
      const val = el('span', { class: 'val num' }, show(get()));
      const input = el('input', { type: 'range', min: 0, max: 100, value: Math.round(get() * 100), 'aria-label': label });
      input.addEventListener('input', () => {
        set(Number(input.value) / 100);
        val.textContent = show(get());
        host.saveSettings();
      });
      return el('label', { class: 'field' }, el('span', {}, label), input, val);
    };

    const select = (label: string, options: [string, string][], value: string, onChange: (v: string) => void) => {
      const sel = el('select', { 'aria-label': label });
      for (const [v, text] of options) {
        const o = el('option', { value: v }, text);
        if (v === value) o.selected = true;
        sel.append(o);
      }
      sel.addEventListener('change', () => onChange(sel.value));
      sel.addEventListener('keydown', (e) => e.stopPropagation());
      return sel;
    };

    const quality = el('div', { class: 'seg', role: 'group', 'aria-label': 'Graphics quality' });
    for (const q of Object.keys(GRAPHICS) as QualityName[]) {
      quality.append(
        el('button', {
          'aria-pressed': String(s.quality === q),
          onclick: () => {
            s.quality = q;
            host.setQuality(q);
            for (const b of quality.children) b.setAttribute('aria-pressed', String(b.textContent === GRAPHICS[q].label));
          },
        }, GRAPHICS[q].label),
      );
    }

    this.side.append(
      el('div', {}, el('h1', {}, 'Helicopter Simulator'), el('p', { class: 'sub' }, 'Choose an aircraft and a place to start.')),
      el('div', { class: 'scroll' },
        el('div', { class: 'label section' }, 'Aircraft'),
        this.listAircraft,
        el('div', { class: 'label section' }, 'Start'),
        this.listPads,
        el('div', { class: 'label section' }, 'Load'),
        range('Fuel', () => s.fuel, (v) => (s.fuel = Math.max(0.1, v)), (v) => `${Math.round(v * 100)} %`),
        range('Payload', () => s.payload, (v) => (s.payload = v), (v) => `${fmt(this.payloadKg(v))} kg`),
        el('div', { class: 'label section' }, 'World seed'),
        el('div', { class: 'seed' }, seedInput, el('button', { class: 'btn', onclick: () => host.reseed(seedInput.value) }, 'Load'), el('button', { class: 'btn', onclick: () => host.reseed(null) }, 'New')),
        el('div', { class: 'label section' }, 'Multiplayer'),
        this.multiplayerSection(),
        el('div', { class: 'label section' }, 'Options'),
        el('div', { class: 'field' }, el('span', {}, 'Weather'), select('Weather', [['auto', 'Changing'], ...WEATHER_ORDER.map((id): [string, string] => [id, WEATHER[id].label])], s.weather, (v) => {
          s.weather = v;
          host.setWeather(v);
          host.saveSettings();
        })),
        el('div', { class: 'field' }, el('span', {}, 'Time of day'), select('Time of day', TIMES.map(([l, h]): [string, string] => [String(h), l]), String(TIMES.some(([, h]) => h === s.hour) ? s.hour : -1), (v) => {
          s.hour = Number(v);
          host.setHour(s.hour);
          host.saveSettings();
        })),
        range('Volume', () => s.volume, (v) => {
          s.volume = v;
          host.setVolume(v);
        }, (v) => `${Math.round(v * 100)} %`),
        el('div', { class: 'field' }, el('span', {}, 'Graphics'), quality),
        el('div', { class: 'field' }, el('span', {}, 'Key bindings'), el('button', { class: 'btn', onclick: () => host.openControls() }, 'Controls…')),
      ),
      el('div', { class: 'go' }, this.resumeBtn, this.flyBtn),
    );
    root.append(this.side, this.specs);
    this.renderAircraft();
    this.renderSpecs();
  }

  private multiplayerSection(): HTMLElement {
    const host = this.host, s = host.settings;
    if (!host.netAvailable) {
      return el('p', { class: 'net-status' }, 'Multiplayer needs a relay server. See README, "Multiplayer".');
    }
    const name = el('input', { value: s.callsign, spellcheck: false, 'aria-label': 'Callsign', maxlength: 16 });
    const commit = () => {
      const v = name.value.trim().slice(0, 16);
      if (!v || v === s.callsign) {
        name.value = s.callsign;
        return;
      }
      s.callsign = v;
      host.saveSettings();
      host.setCallsign(v);
    };
    name.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') name.blur();
    });
    name.addEventListener('change', commit);
    this.setNet('Pilots on the same world seed fly together.', false);
    return el('div', {},
      el('div', { class: 'seed callsign' }, name),
      this.netStatus,
      el('div', { class: 'net-row' }, this.netBtn, this.inviteBtn),
    );
  }

  /** Connection line under the multiplayer heading, and which button shows. */
  setNet(text: string, online: boolean): void {
    if (this.netStatus.textContent !== text) this.netStatus.textContent = text;
    this.netStatus.classList.toggle('on', online);
    this.netOnline = online;
    this.netBtn.textContent = online ? 'Go offline' : 'Play online';
    this.inviteBtn.style.display = online ? '' : 'none';
  }

  /** Payload in kg for a slider position: the fraction of the room left under max takeoff weight. */
  payloadKg(fraction: number): number {
    const d = AIRCRAFT[this.aircraft], s = this.host.settings;
    const room = d.mass.maxTakeoff - d.mass.empty - d.mass.crew - d.fuel.capacity * s.fuel;
    return Math.max(0, Math.round((room * fraction) / 10) * 10);
  }

  /** Open the menu. With `resumable`, the flight in progress stays until something else is picked. */
  open(resumable = false): void {
    this.isOpen = true;
    this.pads = this.host.helipads().slice(0, 14);
    if (!this.pad || !this.pads.includes(this.pad)) this.pad = this.pads.find((p) => p.kind === 'ground' && p.rank === 3) ?? this.pads[0] ?? null;
    this.renderPads();
    this.root.classList.add('open');
    this.setResumable(resumable);
    if (!resumable) this.host.preview(this.aircraft, this.pad);
    (resumable ? this.resumeBtn : this.flyBtn).focus({ preventScroll: true });
  }

  private setResumable(r: boolean): void {
    this.resumable = r;
    this.resumeBtn.style.display = r ? '' : 'none';
    this.resumeBtn.className = r ? 'btn primary wide' : 'btn wide';
    this.flyBtn.className = r ? 'btn wide' : 'btn primary wide';
    this.flyBtn.textContent = r ? 'New flight' : 'Fly';
  }

  /** Show the current choice behind the menu (this ends any flight in progress). */
  private showPreview(): void {
    if (this.resumable) this.setResumable(false);
    this.host.preview(this.aircraft, this.pad);
  }

  close(): void {
    this.isOpen = false;
    this.root.classList.remove('open');
  }

  private pick(aircraft: string): void {
    this.aircraft = aircraft;
    this.host.settings.aircraft = aircraft;
    this.host.saveSettings();
    this.renderAircraft();
    this.renderSpecs();
    this.showPreview();
  }

  private renderAircraft(): void {
    this.listAircraft.replaceChildren(
      ...AIRCRAFT_ORDER.map((id) =>
        el('button', { class: 'row', role: 'option', 'aria-selected': String(id === this.aircraft), onclick: () => this.pick(id) },
          el('span', { class: 'name' }, `${AIRCRAFT[id].name}`),
          el('span', { class: 'meta' }, AIRCRAFT[id].role),
        ),
      ),
    );
  }

  private renderPads(): void {
    const row = (pad: Helipad | null, name: string, meta: string) =>
      el('button', {
        class: 'row', role: 'option', 'aria-selected': String(pad === this.pad),
        onclick: () => {
          this.pad = pad;
          this.renderPads();
          this.showPreview();
        },
      }, el('span', { class: 'name' }, name), el('span', { class: 'meta num' }, meta));
    const first = this.pads[0];
    this.listPads.replaceChildren(
      ...this.pads.map((p) => {
        const km = first ? Math.hypot(p.x - first.x, p.z - first.z) / 1000 : 0;
        return row(p, p.name, p.kind === 'roof' ? `Roof · ${fmt(km, 1)} km` : `${fmt(km, 1)} km`);
      }),
      row(null, 'Free flight', 'Airborne, 300 m'),
    );
  }

  private renderSpecs(): void {
    const d = AIRCRAFT[this.aircraft];
    const head = el('tr', {}, el('th', {}, ''), ...AIRCRAFT_ORDER.map((id) => el('th', { class: id === this.aircraft ? 'sel' : '' }, AIRCRAFT[id].name)));
    // Long text rows wrap, one item per line, so the table keeps to the panel's width.
    const cell = (label: string, id: string, text: string) => {
      const wrap = WRAP_ROWS.has(label);
      const td = el('td', { class: `${wrap ? 'wrap' : 'num'}${id === this.aircraft ? ' sel' : ''}` });
      if (wrap) td.append(...text.split(' · ').map((part) => el('span', {}, part)));
      else td.textContent = text;
      return td;
    };
    const body = SPEC_ROWS.map(([label, f]) => el('tr', {}, el('td', {}, label), ...AIRCRAFT_ORDER.map((id) => cell(label, id, f(id)))));
    this.specs.replaceChildren(
      el('div', { class: 'head' }, el('h2', {}, d.name), el('span', { class: 'label' }, `${d.designation} · ${d.role}`)),
      el('p', { class: 'blurb' }, `${d.blurb} Top speed ${d.perf.topSpeedKts} kt (${fmt((d.perf.topSpeedKts * KTS * 3.6))} km/h).`),
      el('table', {}, el('thead', {}, head), el('tbody', {}, ...body)),
    );
  }
}
