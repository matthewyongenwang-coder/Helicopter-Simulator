import { FlightAudio } from './audio/audio';
import { AIRCRAFT } from './data/aircraft';
import type { Action } from './data/controls';
import type { QualityName } from './data/graphics';
import { DAY_CYCLE, WEATHER } from './data/weather';
import * as THREE from 'three';
import { Owner } from './game/combat';
import { AIM_NDC_Y, Game, type SpawnLoad, type SpawnPoint } from './game/game';
import { keyLabel, loadSettings, saveSettings } from './game/settings';
import { CombatHud } from './ui/combatHud';
import { Hud } from './ui/hud';
import { el, Menu } from './ui/menu';
import { ControlsOverlay } from './ui/overlays';
import './ui/styles.css';
import { randomSeed, seedFromString, seedToString } from './world/rng';
import type { Helipad } from './world/structures';
import { Multiplayer } from './game/multiplayer';
import { NetClient } from './net/netClient';
import { cleanName, cleanRoom, isLobbyInfo, ROOM_LIMIT, type LobbyInfo } from './net/protocol';
import { PilotTags } from './ui/pilotTags';

const params = new URLSearchParams(location.search);
const settings = loadSettings();
const seedParam = params.get('seed');
const seed = seedParam ? seedFromString(seedParam) : randomSeed();
const q = params.get('quality');
if (q === 'low' || q === 'medium' || q === 'high') settings.quality = q;
// Own keys only: `?aircraft=constructor` must not pick up an inherited property.
const acParam = params.get('aircraft');
if (acParam && Object.hasOwn(AIRCRAFT, acParam)) settings.aircraft = acParam;
const wxParam = params.get('weather');
if (wxParam && (wxParam === 'auto' || Object.hasOwn(WEATHER, wxParam))) settings.weather = wxParam;
const hourParam = Number(params.get('hour') ?? NaN);
if (params.get('hour') && Number.isFinite(hourParam) && hourParam >= 0 && hourParam <= 24) settings.hour = hourParam;
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

// ---- Multiplayer ----------------------------------------------------------------------
// The relay address comes from the build (VITE_RELAY_URL), never from the page's URL, so a
// link cannot point the game at someone else's server. In development it defaults to a
// relay running on this machine (`npm run dev` in relay/).
const relayUrl: string = import.meta.env.VITE_RELAY_URL || (import.meta.env.DEV ? `ws://${location.hostname}:8787` : '');
/** The room is the world seed: everyone on the same seed flies together. */
let mp: Multiplayer | null = null;
let netNote = '';
let netNoteTimer = 0;

function setOnlineParam(on: boolean): void {
  const p = new URLSearchParams(location.search);
  if (on) p.set('online', '1');
  else p.delete('online');
  const q = p.toString();
  history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}${location.hash}`);
}

function goOnline(): void {
  if (!relayUrl || mp) return;
  mp = new Multiplayer(game, new NetClient(relayUrl, seedText, cleanName(settings.callsign)));
  mp.onNotice = (text, kind) => combatHud.say(text, kind);
  game.onNet = (dt) => mp?.update(dt);
  setOnlineParam(true);
}

function goOffline(): void {
  mp?.dispose();
  mp = null;
  game.onNet = null;
  hud.minimap.pilots = [];
  pilotTags.hide();
  setOnlineParam(false);
}

function copyInvite(): void {
  const p = new URLSearchParams({ seed: seedText, online: '1' });
  const url = `${location.origin}${location.pathname}?${p}`;
  const done = (ok: boolean) => {
    netNote = ok ? 'Invite link copied' : url;
    netNoteTimer = ok ? 2.5 : 20;
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => done(true), () => done(false));
  else done(false);
}

/** Rooms with pilots in them, from the relay's lobby list (`ws://host` → `http://host/lobbies`). */
async function listLobbies(): Promise<LobbyInfo[]> {
  if (!relayUrl) return [];
  const res = await fetch(`${relayUrl.replace(/^ws/i, 'http').replace(/\/$/, '')}/lobbies`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Lobby list: ${res.status}`);
  const list: unknown = await res.json();
  if (!Array.isArray(list)) return [];
  // Only rooms named for a world seed can be joined (that is all the game ever opens).
  const isSeed = (room: string) => seedToString(seedFromString(room)) === room;
  return list.filter(isLobbyInfo).map((l) => ({ ...l, room: cleanRoom(l.room), names: l.names.map(cleanName) })).filter((l) => isSeed(l.room));
}

/** Fly in another room: its code is its world seed, so load that world and go online there. */
function joinRoom(room: string): void {
  room = cleanRoom(room);
  if (!room) return;
  if (room === seedText) {
    goOnline();
    return;
  }
  const p = new URLSearchParams(location.search);
  p.set('seed', room);
  p.set('online', '1');
  p.delete('autostart');
  location.search = p.toString();
}

function netStatusText(): string {
  if (netNoteTimer > 0) return netNote;
  if (!mp) return 'Pilots on the same world seed fly together.';
  switch (mp.client.status) {
    case 'online': return `Room ${seedText} · ${mp.count} pilot${mp.count === 1 ? '' : 's'}`;
    case 'full': return `Room ${seedText} is full (${ROOM_LIMIT} pilots)`;
    case 'offline': return 'Offline';
    default: return `Connecting to room ${seedText}…`;
  }
}

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
    game.setSupplyHome(pad ? padPoint(pad) : home);
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
  netAvailable: !!relayUrl,
  goOnline: () => goOnline(),
  goOffline: () => goOffline(),
  copyInvite: () => copyInvite(),
  room: seedText,
  listLobbies,
  joinRoom,
  setCallsign: () => {
    if (!mp) return;
    goOffline();
    goOnline();
  },
});

const hud = new Hud(ui, game.world, game.pool, (x, z, r) => game.helipads(x, z, r), {
  respawn: () => game.respawn(),
  menu: () => openMenu(),
  keys: keyLabels,
});

const combatHud = new CombatHud(ui);
const pilotTags = new PilotTags(ui);
let netTimer = 0;
const projV = new THREE.Vector3();
const camDir = new THREE.Vector3();
/** World point → screen pixels. */
const project = (x: number, y: number, z: number) => {
  const o = game.engine.origin;
  projV.set(x - o.x, y, z - o.z).project(game.engine.camera);
  return { x: ((projV.x + 1) / 2) * window.innerWidth, y: ((1 - projV.y) / 2) * window.innerHeight, front: projV.z < 1 };
};
let beepTimer = 0;
let crackTimer = 0;
let tickTimer = 0;
let mapTimer = 0;

/** Sounds for this frame's shooting and blasts. */
function combatAudio(dt: number): void {
  const h = game.sim.heli, c = game.combat;
  const heavy = (c.loadout.gun?.damage ?? 0) >= 10;
  crackTimer -= dt;
  tickTimer -= dt;
  for (const e of game.combatEvents) {
    const dist = 'x' in e ? Math.hypot(e.x - h.pos.x, e.y - h.pos.y, e.z - h.pos.z) : 0;
    switch (e.type) {
      case 'gunFire': audio.gunShot(heavy); break;
      case 'enemyFire': audio.enemyShot(e.dist, e.kind === Owner.Aaa); break;
      case 'missileLaunch': audio.missileLaunch(e.enemy, dist); break;
      case 'flare': if (!e.remote) audio.flarePop(); break;
      case 'explosion': audio.boom(dist, e.size); break;
      case 'partDestroyed': audio.boom(dist, e.size + 0.5); break;
      case 'compoundDestroyed': {
        const s = e.compound.site;
        audio.boom(Math.hypot(s.x - h.pos.x, s.z - h.pos.z), 4.5);
        break;
      }
      case 'flak': audio.boom(dist, 0.35); break;
      case 'nearMiss':
        if (crackTimer <= 0) {
          audio.crack();
          crackTimer = 0.06;
        }
        break;
      case 'playerHit': audio.ping(e.missile); break;
      case 'hitConfirm':
        if (tickTimer <= 0 || e.kill) {
          audio.tone(e.kill ? 1500 : 2300, 0.035, e.kill ? 0.09 : 0.04);
          tickTimer = 0.07;
        }
        break;
      case 'locked': audio.chime([1760, 1760], 0.07, 0.06); break;
      case 'empty': audio.tone(260, 0.05, 0.1, 'square'); break;
      default: break;
    }
  }
  // Warning tones: fast for a missile in the air, slow for a radar lock.
  beepTimer -= dt;
  if (game.mode === 'fly' && !h.destroyed && !game.paused && beepTimer <= 0) {
    if (c.incoming > 0) {
      audio.tone(1250, 0.07, 0.07, 'square');
      beepTimer = 0.16;
    } else if (c.samLocking) {
      audio.tone(880, 0.12, 0.05, 'square');
      beepTimer = 0.7;
    }
  }
}

/** Warning pills for the HUD. */
function combatPills(): [string, string][] {
  const c = game.combat, k = keyLabels();
  const out: [string, string][] = [];
  if (c.incoming > 0) out.push(['warning blink', `Missile · ${k.flares} flares`]);
  else if (c.samLocking) out.push(['caution', 'SAM radar lock']);
  if (c.threats.length > 0 && c.incoming === 0) out.push(['caution', 'Under fire']);
  return out;
}

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
      weatherId: W.target,
      weatherLeaving: W.leaving,
      daylight: game.sky.daylight,
      nightVision: game.nightVision,
      windX: W.windX,
      windZ: W.windZ,
      turbulence: W.areaTurbulence + W.cur.gust,
      seed: seedText,
      mouseLook: mouseLooking(),
      combat: combatPills(),
    }, dt);
    const cam = game.engine.camera;
    cam.getWorldDirection(camDir);
    const fl = Math.hypot(camDir.x, camDir.z) || 1;
    combatHud.update({
      combat: game.combat,
      events: game.combatEvents,
      project,
      aimNdcY: AIM_NDC_Y[game.rig.mode],
      camFx: camDir.x / fl,
      camFz: camDir.z / fl,
      x: h.pos.x, y: h.pos.y, z: h.pos.z,
      flash: game.combatView.screenFlash,
      alive: !h.destroyed,
      keys: keyLabels(),
      supply: game.supply.status,
      supplyEvents: game.supplyEvents,
    }, dt);
    mapTimer -= dt;
    if (mapTimer <= 0) {
      mapTimer = 0.5;
      hud.minimap.compounds = [...game.combat.compounds.values()].map((c) => ({ x: c.site.x, z: c.site.z, dead: c.destroyed, hot: c.engaged }));
      hud.minimap.supplies = game.supply.sites;
      hud.minimap.pilots = mp ? [...mp.peers.values()].filter((p) => p.shown).map((p) => ({ x: p.x, z: p.z, heading: p.heading, dead: p.destroyed })) : [];
    }
    if (mp) {
      const me = h.pos;
      pilotTags.update([...mp.peers.values()].filter((p) => p.shown).map((p) => ({ name: p.name, x: p.x, y: p.y, z: p.z, dist: Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z), dead: p.destroyed })), project);
    }
  }
  netNoteTimer -= dt;
  netTimer -= dt;
  if (menu.isOpen && netTimer <= 0) {
    netTimer = 0.25;
    menu.setNet(netStatusText(), !!mp);
  }
  combatAudio(dt);
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
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== canvas) game.gunHeld = game.missileHeld = false;
});
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
  game.gunHeld = game.missileHeld = false;
}
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (controls.isOpen) return;
  // Once the view follows the mouse, the buttons are the triggers: left gun, right missile.
  if (mouseLooking() && game.mode === 'fly' && !game.paused) {
    if (e.button === 0) game.gunHeld = true;
    else if (e.button === 2) {
      game.fireMissile();
      game.missileHeld = true;
    }
    return;
  }
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
document.addEventListener('pointerup', (e) => {
  if (e.button === 0) game.gunHeld = false;
  if (e.button === 2) game.missileHeld = false;
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
if (params.get('online') === '1') goOnline();
game.start();

// Handle for the end-to-end tests and for poking at the game from the console.
Object.assign(window, { __combatHud: combatHud, __game: game, __menu: menu, __settings: settings, __hud: hud, __audio: audio, __controls: controls, __net: () => mp });
