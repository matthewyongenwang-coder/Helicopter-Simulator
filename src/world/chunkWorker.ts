/// <reference lib="webworker" />
import { buildTerrainMesh } from './meshgen';
import { World } from './world';

export type WorkerRequest =
  | { type: 'init'; seed: number }
  | { type: 'terrain'; id: number; x0: number; z0: number; size: number; cells: number };

export type WorkerResponse = {
  type: 'terrain';
  id: number;
  positions: Float32Array;
  normals: Int8Array;
  colors: Uint8Array;
  minY: number;
  maxY: number;
};

let world: World | null = null;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  if (m.type === 'init') {
    world = new World(m.seed);
    return;
  }
  if (!world) return;
  if (m.type === 'terrain') {
    const d = buildTerrainMesh(world, m.x0, m.z0, m.size, m.cells);
    const res: WorkerResponse = { type: 'terrain', id: m.id, ...d };
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(res, [d.positions.buffer, d.normals.buffer, d.colors.buffer]);
  }
};
