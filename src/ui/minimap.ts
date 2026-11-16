import type { MapResponse } from '../world/chunkWorker';
import { RoadKind } from '../world/roads';
import { SettlementKind } from '../world/settlements';
import type { Helipad } from '../world/structures';
import type { WorkerPool } from '../world/workerPool';
import type { World } from '../world/world';

/** Zoom levels: half-width shown (m) and the tile size used for it (m per 128 px tile). */
const ZOOMS = [
  { radius: 1100, tile: 1536 },
  { radius: 3200, tile: 4096 },
  { radius: 9000, tile: 12288 },
];
const TILE_PX = 128;
const MAX_TILES = 90;

interface Tile {
  canvas: HTMLCanvasElement | null;
  used: number;
}

/**
 * North-up moving map. Terrain tiles are rendered in the chunk workers and
 * cached; roads, towns, helipads and the aircraft are drawn on top.
 */
export class Minimap {
  readonly canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private tiles = new Map<string, Tile>();
  private frame = 0;
  zoom = 1;
  private pads: Helipad[] = [];
  private padsAt = { x: Infinity, z: Infinity };
  private dpr = Math.min(2, window.devicePixelRatio || 1);

  constructor(private world: World, private pool: WorkerPool, private helipads: (x: number, z: number, r: number) => Helipad[], private size = 200) {
    this.canvas.width = size * this.dpr;
    this.canvas.height = size * this.dpr;
    this.canvas.style.width = this.canvas.style.height = `${size}px`;
    this.canvas.className = 'minimap';
    this.ctx = this.canvas.getContext('2d')!;
  }

  get radius(): number {
    return ZOOMS[this.zoom].radius;
  }

  cycleZoom(): void {
    this.zoom = (this.zoom + 1) % ZOOMS.length;
  }

  private tile(level: number, i: number, j: number, cx: number, cz: number): Tile {
    const key = `${level}:${i}:${j}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = { canvas: null, used: this.frame };
      this.tiles.set(key, t);
      const size = ZOOMS[level].tile;
      const tile = t;
      this.pool.submit(
        { type: 'map', x0: i * size, z0: j * size, size, px: TILE_PX },
        // After the terrain: map tiles only matter once the world around the aircraft is up.
        () => 1e7 + Math.hypot((i + 0.5) * size - cx, (j + 0.5) * size - cz),
        (res) => {
          const c = document.createElement('canvas');
          c.width = c.height = TILE_PX;
          const img = new ImageData((res as MapResponse).rgba as Uint8ClampedArray<ArrayBuffer>, TILE_PX, TILE_PX);
          c.getContext('2d')!.putImageData(img, 0, 0);
          tile.canvas = c;
        },
      );
      if (this.tiles.size > MAX_TILES) this.evict();
    }
    t.used = this.frame;
    return t;
  }

  private evict(): void {
    const old = [...this.tiles.entries()].filter(([, t]) => t.canvas).sort((a, b) => a[1].used - b[1].used);
    for (let k = 0; k < old.length && this.tiles.size > MAX_TILES * 0.8; k++) this.tiles.delete(old[k][0]);
  }

  /** Draw the map around (x, z). `heading` in radians (0 = north, clockwise). */
  draw(x: number, z: number, heading: number, last: { x: number; z: number } | null, wind: { x: number; z: number }): void {
    this.frame++;
    const c = this.ctx, S = this.size, dpr = this.dpr;
    const z0 = ZOOMS[this.zoom];
    const R = z0.radius;
    const scale = S / (2 * R); // css px per metre
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#1d4a63';
    c.fillRect(0, 0, S, S);
    // World → map: north (−z) up.
    const mx = (wx: number) => S / 2 + (wx - x) * scale;
    const my = (wz: number) => S / 2 + (wz - z) * scale;

    // Terrain tiles (fall back to the next coarser level while a tile is coming).
    c.imageSmoothingEnabled = true;
    const ts = z0.tile;
    const i0 = Math.floor((x - R) / ts), i1 = Math.floor((x + R) / ts);
    const j0 = Math.floor((z - R) / ts), j1 = Math.floor((z + R) / ts);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const t = this.tile(this.zoom, i, j, x, z);
        const px = mx(i * ts), py = my(j * ts), w = ts * scale;
        if (t.canvas) c.drawImage(t.canvas, px, py, w + 0.5, w + 0.5);
        else if (this.zoom + 1 < ZOOMS.length) {
          const big = ZOOMS[this.zoom + 1].tile;
          const bi = Math.floor((i * ts) / big), bj = Math.floor((j * ts) / big);
          const bt = this.tiles.get(`${this.zoom + 1}:${bi}:${bj}`);
          if (bt?.canvas) {
            const f = TILE_PX / big;
            c.drawImage(bt.canvas, (i * ts - bi * big) * f, (j * ts - bj * big) * f, ts * f, ts * f, px, py, w + 0.5, w + 0.5);
          }
        }
      }
    }

    // Roads.
    const roads = this.world.roads.inRect(x - R, z - R, x + R, z + R);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const pass of [0, 1]) {
      for (const road of roads) {
        const hw = road.kind === RoadKind.Highway;
        c.strokeStyle = pass === 0 ? 'rgba(20,22,26,0.55)' : hw ? '#f5d76e' : '#e9e4da';
        c.lineWidth = (hw ? 2.4 : 1.4) + (pass === 0 ? 1.4 : 0);
        c.beginPath();
        const step = Math.max(1, Math.floor(road.points.length / 400));
        for (let k = 0; k < road.points.length; k += step) {
          const p = road.points[k];
          if (k === 0) c.moveTo(mx(p.x), my(p.z));
          else c.lineTo(mx(p.x), my(p.z));
        }
        const lastP = road.points[road.points.length - 1];
        c.lineTo(mx(lastP.x), my(lastP.z));
        c.stroke();
      }
    }

    // Helipads (refreshed when the aircraft has moved a little).
    if (Math.hypot(x - this.padsAt.x, z - this.padsAt.z) > 400) {
      this.pads = this.helipads(x, z, 12000);
      this.padsAt = { x, z };
    }
    c.font = '700 9px -apple-system, system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (const p of this.pads) {
      const px = mx(p.x), py = my(p.z);
      if (px < -6 || py < -6 || px > S + 6 || py > S + 6) continue;
      if (p.kind === 'roof' && this.zoom > 0) continue;
      c.fillStyle = 'rgba(10,12,16,0.75)';
      c.beginPath();
      c.arc(px, py, 5.5, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#64d2ff';
      c.fillText('H', px, py + 0.5);
    }

    // Town names.
    c.font = '600 10px -apple-system, system-ui, sans-serif';
    for (const s of this.world.settlements.within(x, z, R * 1.4)) {
      if (s.kind < SettlementKind.Town && this.zoom > 0) continue;
      const px = mx(s.x), py = my(s.z);
      if (px < 0 || py < 0 || px > S || py > S) continue;
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(0,0,0,0.6)';
      c.strokeText(s.name, px, py - 10);
      c.fillStyle = s.kind === SettlementKind.City ? '#ffffff' : 'rgba(255,255,255,0.82)';
      c.fillText(s.name, px, py - 10);
    }

    // Last helipad (respawn point).
    if (last) {
      const px = Math.max(6, Math.min(S - 6, mx(last.x))), py = Math.max(6, Math.min(S - 6, my(last.z)));
      c.strokeStyle = '#30d158';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(px, py, 7.5, 0, Math.PI * 2);
      c.stroke();
    }

    // Aircraft.
    c.save();
    c.translate(S / 2, S / 2);
    c.rotate(heading);
    c.fillStyle = '#ffffff';
    c.strokeStyle = 'rgba(0,0,0,0.7)';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(0, -9);
    c.lineTo(6.5, 7);
    c.lineTo(0, 3.5);
    c.lineTo(-6.5, 7);
    c.closePath();
    c.stroke();
    c.fill();
    c.restore();

    // North mark and wind arrow.
    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.font = '700 10px -apple-system, system-ui, sans-serif';
    c.fillText('N', S / 2, 9);
    const ws = Math.hypot(wind.x, wind.z);
    if (ws > 0.5) {
      c.save();
      c.translate(S - 18, S - 18);
      c.rotate(Math.atan2(wind.z, wind.x) + Math.PI / 2);
      c.strokeStyle = '#ffffff';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(0, 8);
      c.lineTo(0, -8);
      c.moveTo(-4, -3);
      c.lineTo(0, -8);
      c.lineTo(4, -3);
      c.stroke();
      c.restore();
    }
  }
}
