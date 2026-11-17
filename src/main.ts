import { FlightAudio } from './audio/audio';
import { AIRCRAFT } from './data/aircraft';
import type { Action } from './data/controls';
import type { QualityName } from './data/graphics';
import { DAY_CYCLE } from './data/weather';
import { Game, type SpawnLoad, type SpawnPoint } from './game/game';
import { keyLabel, loadSettings, saveSettings } from './game/settings';
import { Hud } from './ui/hud';
import { el, Menu } from './ui/menu';
import { ControlsOverlay } from './ui/overlays';
import './ui/styles.css';
import { randomSeed, seedFromString, seedToString } from './world/rng';
import type { Helipad } from './world/structures';

const params = new URLSearchParams(location.search);
const settings = loadSettings();
const seedParam = params.get('seed');
const seed = seedParam ? seedFromString(seedParam) : randomSeed();
const q = params.get('quality');
if (q === 'low' || q === 'medium' || q === 'high') settings.quality = q;
if (params.get('aircraft') && AIRCRAFT[params.get('aircraft')!]) settings.aircraft = params.get('aircraft')!;
if (params.get('weather')) settings.weather = params.get('weather')!;
if (params.get('hour')) settings.hour = Number(params.get('hour'));
const autostart = params.get('autostart') === '1';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const debug = document.getElementById('hud') as HTMLElement;
const ui = document.getElementById('ui') as HTMLElement;
const menuRoot = document.getElementById('menu') as HTMLElement;
const overlays = document.getElementById('overlays') as HTMLElement;
const loading = el('div', { class: 'loading glass' }, 'Generating world…');
document.body.append(loading);

const game = new Game({
  canvas,
  hud: debug,
  seed,
  quality: settings.quality,
  aircraft: settings.aircraft,
  bindings: settings.bindings,
  weather: settings.weather,
  hour: settings.hour,
});
const home: SpawnPoint = game.lastPad;
const seedText = seedToString(seed);

// ---- Audio --------------------------------------------------------------------
const audio = new FlightAudio();
audio.setVolume(settings.volume);
audio.setAircraft(game.aircraft, game.visual);
const unlock = () => audio.unlock();
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);
document.addEventListener('visibilitychange', () => audio.setMuted(document.hidden));
game.weather.onStrike = (d) => audio.thunder(d);
let lastImpacts = 0;
let wasDestroyed = false;
game.onSpawn = () => {
  audio.setAircraft(game.aircraft, game.visual);
  lastImpacts = game.sim.heli.tel.impactCount;
  wasDestroyed = false;
};

/** Reload on a given seed, keeping any other query parameters. */
function reload(seedStr: string): void {
  const p = new URLSearchParams(location.search);
  p.set('seed', seedStr);
  p.delete('autostart');
  location.search = p.toString();
}

const padPoint = (pad: Helipad): SpawnPoint => ({ x: pad.x, z: pad.z, y: pad.y, heading: pad.heading, name: pad.name });

const loadOf = (id: string): SpawnLoad => {
  const d = AIRCRAFT[id];
  const room = d.mass.maxTakeoff - d.mass.empty - d.mass.crew - d.fuel.capacity * settings.fuel;
  return { fuelFraction: settings.fuel, payload: Math.max(0, room * settings.payload) };
};

/** First key bound to each action, for on-screen hints. */
const keyLabels = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [a, codes] of Object.entries(settings.bindings)) out[a] = codes.length ? keyLabel(codes[0]) : '—';
  return out;
};

// ---- Menu, HUD, controls ------------------------------------------------------------
let menu: Menu;
let controls: ControlsOverlay;

function startFlying(): void {
  game.setMode('fly');
  menu.close();
  ui.classList.add('on');
  canvas.focus();
  captureMouse();
}

function openMenu(): void {
  releaseMouse();
  const resumable = game.mode === 'fly' && game.flightTime > 0 && !game.sim.heli.destroyed;
  ui.classList.remove('on');
  game.setMode('menu');
  menu.open(resumable);
}

menu = new Menu(menuRoot, {
  seed,
  settings,
  helipads: () => game.helipads(home.x, home.z, 30000),
  preview: (id, pad) => {
    game.spawn(AIRCRAFT[id], pad ? padPoint(pad) : home, 0, 0, loadOf(id));
    game.setMode('menu');
  },
  fly: (id, pad) => {
    if (pad) game.spawn(AIRCRAFT[id], padPoint(pad), 0, 0, loadOf(id));
    else game.spawn(AIRCRAFT[id], home, 300, 0, loadOf(id));
    startFlying();
  },
  resume: () => startFlying(),
  reseed: (text) => reload(text && text.trim() ? text.trim() : seedToString(randomSeed())),
  setQuality: (quality: QualityName) => {
    settings.quality = quality;
    saveSettings(settings);
    // Terrain resolution and antialiasing are fixed at start-up: reload on the same seed.
    reload(seedText);
  },
  openControls: () => controls.open(),
  saveSettings: () => saveSettings(settings),
  setWeather: (id) => game.weather.setMode(id, true),
  setHour: (h) => (game.weather.hour = h < 0 ? DAY_CYCLE.defaultHour : h),
  setVolume: (v) => {
    audio.setVolume(v);
    saveSettings(settings);
  },
});

const hud = new Hud(ui, game.world, game.pool, (x, z, r) => game.helipads(x, z, r), {
  respawn: () => game.respawn(),
  menu: () => openMenu(),
  keys: keyLabels,
});

controls = new ControlsOverlay(overlays, {
  bindings: () => settings.bindings,
  setBindings: (b: Record<Action, string[]>) => {
    settings.bindings = b;
    saveSettings(settings);
    game.setBindings(b);
  },
  capture: (fn) => (game.input.capture = fn),
  onOpenChange: (open) => {
    if (open) releaseMouse();
    else if (game.mode === 'fly') captureMouse();
    game.paused = open;
    game.sim.actions.releaseAll();
  },
});

game.onAction = (a) => {
  if (a === 'pause') {
    if (controls.isOpen) controls.close();
    else if (menu.isOpen) {
      if (game.flightTime > 0 && !game.sim.heli.destroyed) startFlying();
    } else openMenu();
  } else if (a === 'toggleControls') controls.toggle();
  else if (a === 'toggleMap') hud.minimap.cycleZoom();
  else if (a === 'freeLook') game.rig.recenter();
};

game.onFrame = (dt) => {
  loading.classList.toggle('on', !game.ready);
  game.rig.looking = mouseLooking() || dragging;
  const h = game.sim.heli, t = h.tel, W = game.weather;
  // Free the cursor for the crash banner's buttons.
  if (h.destroyed && mouseCaptured()) releaseMouse();
  const flying = game.mode === 'fly';
  if (flying) {
    hud.update({
      tel: t,
      aircraft: game.aircraft,
      engine: h.engine,
      autohoverEngaged: h.autohover.engaged,
      autohoverActive: h.autohover.active,
      destroyed: h.destroyed,
      destroyedReason: h.destroyedReason,
      brake: h.brake,
      x: h.pos.x,
      z: h.pos.z,
      lastPad: game.lastPad,
      hour: W.hour,
      weather: W.label,
      windX: W.windX,
      windZ: W.windZ,
      turbulence: W.areaTurbulence + W.cur.gust,
      seed: seedText,
      mouseLook: mouseLooking(),
    }, dt);
  }
  audio.update({
    dt,
    rotorN: h.rotorN,
    engineOn: h.engine === 'running' || h.engine === 'starting',
    load: t.mass > 0 ? t.thrust / (t.mass * 9.81) : 0,
    torque: t.torque,
    airspeed: t.airspeed,
    slapBoost: Math.max(t.vortexRing, Math.min(1, Math.max(0, -t.verticalSpeed - 1.5) / 5) * Math.max(0, 1 - t.airspeed / 40) * 0.6),
    vibration: t.vibration,
    warnings: flying ? t.warnings : 0,
    cockpit: game.rig.mode === 'cockpit',
    precip: W.cur.precip,
    snow: W.snowing,
    paused: game.paused,
    destroyed: h.destroyed,
    autohover: h.autohover.engaged,
  });
  if (t.impactCount !== lastImpacts) {
    lastImpacts = t.impactCount;
    audio.impact(t.lastImpact);
  }
  if (h.destroyed && !wasDestroyed) audio.explode();
  wasDestroyed = h.destroyed;
};

// Mouse look: click the view once and the camera follows the mouse (pointer lock), with no
// button held. Esc gives the cursor back. Where pointer lock is unavailable, dragging works.
let dragging = false;
/** The browser refused pointer lock (some embedded browsers do): follow plain mouse movement instead. */
let lockRefused = false;
document.addEventListener('pointerlockerror', () => (lockRefused = true));
const mouseCaptured = () => document.pointerLockElement === canvas;
/** The view follows the mouse without a button: captured, or hovering the view where capture is refused. */
const mouseLooking = () => mouseCaptured() || (lockRefused && hovering && game.mode === 'fly' && !controls.isOpen && !game.sim.heli.destroyed);
let hovering = false;
canvas.addEventListener('pointerleave', () => (hovering = false));
function captureMouse(): void {
  if (mouseCaptured() || game.mode !== 'fly' || !canvas.requestPointerLock) return;
  try {
    const p = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    p?.catch?.(() => {});
  } catch {
    // Not allowed without a user gesture: the next click on the view will capture it.
  }
}
function releaseMouse(): void {
  if (mouseCaptured()) document.exitPointerLock();
  dragging = false;
}
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (controls.isOpen) return;
  if (game.mode === 'fly' && !mouseCaptured()) captureMouse();
  if (!mouseCaptured() && (e.button === 0 || e.button === 2)) {
    dragging = true;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // A pointer-lock request is in flight; the drag still works without capture.
    }
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (!dragging) return;
  dragging = false;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
});
document.addEventListener('pointermove', (e) => {
  hovering = e.target === canvas;
  if (mouseLooking() || dragging) game.rig.lookBy(e.movementX, e.movementY);
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Backquote') debug.classList.toggle('on');
});

if (autostart) {
  game.setMode('fly');
  ui.classList.add('on');
} else {
  openMenu();
}
game.start();

// Handle for the end-to-end tests and for poking at the game from the console.
Object.assign(window, { __game: game, __menu: menu, __settings: settings, __hud: hud, __audio: audio, __controls: controls });
