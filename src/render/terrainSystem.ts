import * as THREE from 'three';
import { TERRAIN_LOD } from '../data/graphics';
import { terrainIndices } from '../world/meshgen';
import type { JobHandle, WorkerPool } from '../world/workerPool';
import type { Engine } from './engine';
import { Water } from './water';

const enum State {
  None,
  Pending,
  Ready,
}

interface Node {
  level: number;
  x0: number;
  z0: number;
  size: number;
  children: Node[] | null;
  mesh: THREE.Mesh | null;
  state: State;
  job: JobHandle | null;
  minY: number;
  maxY: number;
  shown: boolean;
}

/** GLSL injected into the terrain material: sRGB vertex colours and world-anchored detail. */
const DETAIL_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

/**
 * Streaming terrain: a quadtree of LOD nodes around the camera. Meshes are
 * generated in workers. A node is only replaced by its children once all four
 * are ready, so there are never holes, and skirts hide the seams between levels.
 */
export class TerrainSystem {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshLambertMaterial;
  private roots = new Map<string, Node>();
  private index: THREE.BufferAttribute;
  private cells: number;
  private rootSize: number;
  private cam = new THREE.Vector3();
  /** `lag`: how overdue the most overdue LOD split is this frame (1 = on time, Infinity = none waiting). */
  stats = { nodes: 0, shown: 0, triangles: 0, generated: 0, lag: Infinity };

  constructor(private engine: Engine, private pool: WorkerPool) {
    this.cells = engine.quality.terrainCells;
    this.rootSize = TERRAIN_LOD.leafSize * 2 ** TERRAIN_LOD.levels;
    this.index = new THREE.BufferAttribute(terrainIndices(this.cells), 1);
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    const originUniform = engine.originUniform;
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uOffset = originUniform;
      shader.uniforms.uDeep = { value: Water.DEEP };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform vec2 uOffset;\nvarying vec2 vDetail;\nvarying float vHeight;')
        .replace('#include <color_vertex>', '#include <color_vertex>\nvColor.rgb = pow(vColor.rgb, vec3(2.2));')
        .replace(
          '#include <project_vertex>',
          '#include <project_vertex>\nvDetail = (modelMatrix * vec4(transformed, 1.0)).xz + uOffset;\nvHeight = transformed.y;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uDeep;\nvarying vec2 vDetail;\nvarying float vHeight;\n' + DETAIL_GLSL)
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            float dist = length(vViewPosition);
            float fine = (vnoise(vDetail * 0.42) - 0.5) * 0.2 * (1.0 - smoothstep(60.0, 420.0, dist));
            float mid = (vnoise(vDetail * 0.047) - 0.5) * 0.16 * (1.0 - smoothstep(600.0, 3500.0, dist));
            diffuseColor.rgb *= 1.0 + fine + mid;
            // Under water the sea bed fades into the water colour with depth.
            float depth = max(0.0, -vHeight);
            diffuseColor.rgb = mix(diffuseColor.rgb, uDeep * 0.45, 1.0 - exp(-depth * 0.2));
          }`,
        );
    };
    this.group.matrixAutoUpdate = false;
    engine.scene.add(this.group);
    engine.onRebase(() => this.reposition());
  }

  /** True once nothing is waiting to be generated. */
  get settled(): boolean {
    return this.pool.pending === 0;
  }

  /** Refresh the quadtree for a camera at world position (x, y, z). */
  update(x: number, y: number, z: number): void {
    this.cam.set(x, y, z);
    const range = this.engine.quality.viewDistance * 1.15;
    const rs = this.rootSize;
    const i0 = Math.floor((x - range) / rs), i1 = Math.floor((x + range) / rs);
    const j0 = Math.floor((z - range) / rs), j1 = Math.floor((z + range) / rs);
    const keep = new Set<string>();
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const key = i + ',' + j;
        keep.add(key);
        if (!this.roots.has(key)) this.roots.set(key, this.makeNode(TERRAIN_LOD.levels, i * rs, j * rs, rs));
      }
    }
    for (const [key, node] of this.roots) {
      if (!keep.has(key)) {
        this.disposeTree(node);
        this.roots.delete(key);
      }
    }
    this.stats.nodes = 0;
    this.stats.shown = 0;
    this.stats.lag = Infinity;
    for (const node of this.roots.values()) this.visit(node);
    this.stats.triangles = this.stats.shown * this.cells * this.cells * 2;
  }

  private makeNode(level: number, x0: number, z0: number, size: number): Node {
    return { level, x0, z0, size, children: null, mesh: null, state: State.None, job: null, minY: -60, maxY: 400, shown: false };
  }

  /** Distance from the camera to the node's bounding box. */
  private distance(n: Node): number {
    const c = this.cam;
    const dx = Math.max(n.x0 - c.x, 0, c.x - (n.x0 + n.size));
    const dz = Math.max(n.z0 - c.z, 0, c.z - (n.z0 + n.size));
    const dy = Math.max(n.minY - c.y, 0, c.y - n.maxY);
    return Math.hypot(dx, dy, dz);
  }

  private visit(n: Node): void {
    this.stats.nodes++;
    const split = TERRAIN_LOD.mergeHysteresis;
    const limit = n.size * this.engine.quality.splitFactor * (n.children ? split : 1);
    if (n.level > 0 && this.distance(n) < limit) {
      if (!n.children) {
        const h = n.size / 2;
        n.children = [
          this.makeNode(n.level - 1, n.x0, n.z0, h),
          this.makeNode(n.level - 1, n.x0 + h, n.z0, h),
          this.makeNode(n.level - 1, n.x0, n.z0 + h, h),
          this.makeNode(n.level - 1, n.x0 + h, n.z0 + h, h),
        ];
      }
      let ready = true;
      for (const c of n.children) {
        this.ensure(c);
        if (c.state !== State.Ready) ready = false;
      }
      if (ready) {
        this.show(n, false);
        for (const c of n.children) this.visit(c);
        return;
      }
      // Children still generating: keep drawing this node, and none of its descendants.
      // Record how overdue the split is (1 = just crossed the threshold, lower = later).
      this.stats.lag = Math.min(this.stats.lag, this.distance(n) / (n.size * this.engine.quality.splitFactor));
      this.ensure(n);
      this.show(n, true);
      for (const c of n.children) this.hideTree(c);
      return;
    }
    if (n.children) {
      for (const c of n.children) this.disposeTree(c);
      n.children = null;
    }
    this.ensure(n);
    this.show(n, true);
  }

  private show(n: Node, on: boolean): void {
    if (on && n.state === State.Ready) this.stats.shown += n.mesh ? 1 : 0;
    if (n.shown === on) return;
    n.shown = on;
    if (n.mesh) n.mesh.visible = on;
  }

  private hideTree(n: Node): void {
    this.show(n, false);
    if (n.children) for (const c of n.children) this.hideTree(c);
  }

  private ensure(n: Node): void {
    if (n.state !== State.None) return;
    n.state = State.Pending;
    n.job = this.pool.submit(
      { type: 'terrain', x0: n.x0, z0: n.z0, size: n.size, cells: this.cells },
      // Nearest first, with large nodes ahead of small ones at the same distance.
      () => this.distance(n) - n.size * 0.5,
      (res) => {
        n.job = null;
        n.state = State.Ready;
        n.minY = res.minY;
        n.maxY = res.maxY;
        this.stats.generated++;
        // Entirely deep under water: nothing worth drawing.
        if (res.maxY < -25) return;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(res.positions, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(res.normals, 3, true));
        geo.setAttribute('color', new THREE.BufferAttribute(res.colors, 4, true));
        geo.setIndex(this.index);
        const cy = (res.minY + res.maxY) / 2;
        geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(n.size / 2, cy, n.size / 2), Math.hypot(n.size * 0.7072, (res.maxY - res.minY) / 2));
        const mesh = new THREE.Mesh(geo, this.material);
        mesh.matrixAutoUpdate = false;
        mesh.receiveShadow = true;
        mesh.visible = n.shown;
        n.mesh = mesh;
        this.place(n);
        this.group.add(mesh);
      },
    );
  }

  private place(n: Node): void {
    if (!n.mesh) return;
    n.mesh.position.set(n.x0 - this.engine.origin.x, 0, n.z0 - this.engine.origin.z);
    n.mesh.updateMatrix();
    n.mesh.matrixWorldNeedsUpdate = true;
  }

  private reposition(): void {
    const walk = (n: Node) => {
      this.place(n);
      if (n.children) for (const c of n.children) walk(c);
    };
    for (const n of this.roots.values()) walk(n);
  }

  private disposeTree(n: Node): void {
    if (n.children) {
      for (const c of n.children) this.disposeTree(c);
      n.children = null;
    }
    if (n.job) {
      n.job.cancel();
      n.job = null;
    }
    if (n.mesh) {
      this.group.remove(n.mesh);
      // The index buffer is shared: detach it before disposing so it survives.
      n.mesh.geometry.setIndex(null);
      n.mesh.geometry.dispose();
      n.mesh = null;
    }
    n.state = State.None;
    n.shown = false;
  }

  dispose(): void {
    for (const n of this.roots.values()) this.disposeTree(n);
    this.roots.clear();
    this.material.dispose();
    this.engine.scene.remove(this.group);
  }
}
