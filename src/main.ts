import type { QualityName } from './data/graphics';
import { Game } from './game/game';
import './ui/styles.css';
import { randomSeed, seedFromString } from './world/rng';

const params = new URLSearchParams(location.search);
const seedParam = params.get('seed');
const seed = seedParam ? seedFromString(seedParam) : randomSeed();
const q = params.get('quality');
const quality: QualityName = q === 'low' || q === 'medium' || q === 'high' ? q : 'medium';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLElement;

const game = new Game({ canvas, hud, seed, quality, aircraft: params.get('aircraft') ?? undefined });
game.start();

// Handle for the end-to-end tests and for poking at the game from the console.
(window as unknown as { __game: Game }).__game = game;
