import { AIRCRAFT } from './data/aircraft';
import type { QualityName } from './data/graphics';
import { Game, type SpawnLoad, type SpawnPoint } from './game/game';
import { loadSettings, saveSettings } from './game/settings';
import { el, Menu } from './ui/menu';
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
const autostart = params.get('autostart') === '1';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const debug = document.getElementById('hud') as HTMLElement;
const ui = document.getElementById('ui') as HTMLElement;
const menuRoot = document.getElementById('menu') as HTMLElement;
const loading = el('div', { class: 'loading glass' }, 'Generating world…');
document.body.append(loading);

const game = new Game({ canvas, hud: debug, seed, quality: settings.quality, aircraft: settings.aircraft, bindings: settings.bindings });
const home: SpawnPoint = game.lastPad;

/** Reload on a given seed, keeping any other query parameters. */
function reload(seedText: string): void {
  const p = new URLSearchParams(location.search);
  p.set('seed', seedText);
  p.delete('autostart');
  location.search = p.toString();
}

const padPoint = (pad: Helipad): SpawnPoint => ({ x: pad.x, z: pad.z, y: pad.y, heading: pad.heading, name: pad.name });

let menu: Menu;
const loadOf = (id: string): SpawnLoad => {
  const d = AIRCRAFT[id];
  const room = d.mass.maxTakeoff - d.mass.empty - d.mass.crew - d.fuel.capacity * settings.fuel;
  return { fuelFraction: settings.fuel, payload: Math.max(0, room * settings.payload) };
};

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
    game.setMode('fly');
    menu.close();
    ui.classList.add('on');
    canvas.focus();
  },
  reseed: (text) => reload(text && text.trim() ? text.trim() : seedToString(randomSeed())),
  setQuality: (quality: QualityName) => {
    settings.quality = quality;
    saveSettings(settings);
    // Terrain resolution and antialiasing are fixed at start-up: reload on the same seed.
    reload(seedToString(seed));
  },
  openControls: () => window.dispatchEvent(new CustomEvent('helisim:controls')),
  saveSettings: () => saveSettings(settings),
});

function openMenu(): void {
  ui.classList.remove('on');
  game.setMode('menu');
  menu.open();
}

game.onAction = (a) => {
  if (a === 'pause') {
    if (menu.isOpen) return;
    openMenu();
  }
};
game.onFrame = () => {
  loading.classList.toggle('on', !game.ready);
  game.rig.looking = dragging || game.sim.actions.isHeld('freeLook');
};

// Free look: drag with the right mouse button, or hold the free-look key and move the mouse.
let dragging = false;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 2 || e.button === 0) {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
  }
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (dragging || game.sim.actions.isHeld('freeLook')) game.rig.lookBy(e.movementX, e.movementY);
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
Object.assign(window, { __game: game, __menu: menu, __settings: settings });
