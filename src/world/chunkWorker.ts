/// <reference lib="webworker" />
import { buildForestCell, type ForestCell } from './forest';
import { buildMapTile, buildTerrainMesh } from './meshgen';
import { buildStructureCell, type StructureCell } from './structures';
import { World } from './world';

export type WorkerRequest =
  | { type: 'init'; seed: number }
  | { type: 'terrain'; id: number; x0: number; z0: number; size: number; cells: number }
  | { type: 'structures'; id: number; cx: number; cz: number }
  | { type: 'forest'; id: number; cx: number; cz: number; density: number }
  | { type: 'map'; id: number; x0: number; z0: number; size: number; px: number };

export type TerrainResponse = {
  type: 'terrain';
  id: number;
  positions: Float32Array;
  normals: Int8Array;
  colors: Uint8Array;
  minY: number;
  maxY: number;
};
export type StructureResponse = { type: 'structures'; id: number; cell: StructureCell };
export type ForestResponse = { type: 'forest'; id: number; cell: ForestCell };
export type MapResponse = { type: 'map'; id: number; rgba: Uint8ClampedArray };
export type WorkerResponse = TerrainResponse | StructureResponse | ForestResponse | MapResponse;

let world: World | null = null;
const post = (res: WorkerResponse, transfer: Transferable[]) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(res, transfer);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  if (m.type === 'init') {
    world = new World(m.seed);
    return;
  }
  if (!world) return;
  if (m.type === 'terrain') {
    const d = buildTerrainMesh(world, m.x0, m.z0, m.size, m.cells);
    post({ type: 'terrain', id: m.id, ...d }, [d.positions.buffer, d.normals.buffer, d.colors.buffer]);
  } else if (m.type === 'structures') {
    const cell = buildStructureCell(world, m.cx, m.cz);
    const buffers: Transferable[] = [];
    for (const v of Object.values(cell)) if (ArrayBuffer.isView(v)) buffers.push(v.buffer);
    post({ type: 'structures', id: m.id, cell }, buffers);
  } else if (m.type === 'forest') {
    const cell = buildForestCell(world, m.cx, m.cz, m.density);
    post({ type: 'forest', id: m.id, cell }, [cell.trees.buffer]);
  } else if (m.type === 'map') {
    const rgba = buildMapTile(world, m.x0, m.z0, m.size, m.px);
    post({ type: 'map', id: m.id, rgba }, [rgba.buffer]);
  }
};
