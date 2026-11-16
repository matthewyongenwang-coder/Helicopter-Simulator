import * as THREE from 'three';
import { PROPS } from '../data/world';
import { TREE_STRIDE, type ForestCell } from '../world/forest';
import { BOAT_STRIDE, BOX_STRIDE, HOUSE_STRIDE, PAD_STRIDE, POLE_STRIDE, SLAB_STRIDE, type StructureCell } from '../world/structures';
import type { JobHandle, WorkerPool } from '../world/workerPool';
import type { Engine } from './engine';
import {
  boatGeometry, boxGeometry, broadleafGeometry, coniferGeometry, helipadTexture, houseGeometry, lampPoleGeometry,
  pylonGeometry, slabGeometry, turbineRotorGeometry, turbineTowerGeometry,
} from './propGeometry';

interface Part {
  obj: THREE.Object3D;
  /** Hidden beyond this distance from the cell centre, m. */
  maxDist: number;
  /** Only shown at night (street-light glow). */
  night?: boolean;
}

interface CellRec {
  key: string;
  cx: number;
  cz: number;
  x0: number;
  z0: number;
  group: THREE.Group | null;
  parts: Part[];
  job: JobHandle | null;
  ready: boolean;
  disposables: { dispose(): void }[];
}

export interface PropCallbacks {
  onStructures(key: string, cell: StructureCell): void;
  onRemove(key: string): void;
}

const HASH_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}`;

const WALLS = [0xd9d2c3, 0xf0ede6, 0xcbb89a, 0xb9c4cc, 0x9c5a48, 0xc9a877, 0xe6dba6].map((c) => new THREE.Color(c));
const ROOFS = [0x8a4a36, 0x3c3f44, 0x5b4636, 0x46586a, 0x6e3028].map((c) => new THREE.Color(c));

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0), _c = new THREE.Color();

function compose(x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number): THREE.Matrix4 {
  _q.setFromAxisAngle(_up, yaw);
  return _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

/**
 * Streams everything that stands on the terrain: buildings, roads, bridges,
 * helipads, pylons, turbines and boats in 1 km structure cells, and individual
 * trees in 256 m forest cells close to the camera. All of it is instanced.
 */
export class PropSystem {
  readonly group = new THREE.Group();
  private structures = new Map<string, CellRec>();
  private forests = new Map<string, CellRec>();
  private lastX = Infinity;
  private lastZ = Infinity;
  private cam = new THREE.Vector3();
  private frame = 0;
  readonly night = { value: 0 };
  private fogDensity = { value: 0.0001 };
  stats = { structureCells: 0, forestCells: 0, buildings: 0, trees: 0, lights: 0 };

  // Shared geometry and materials.
  private gBox = boxGeometry();
  private gHouse = houseGeometry();
  private gSlab = slabGeometry();
  private gPad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private gPole = lampPoleGeometry();
  private gPylon = pylonGeometry();
  private gTower = turbineTowerGeometry();
  private gRotor = turbineRotorGeometry();
  private gBoat = boatGeometry();
  private gTree = [broadleafGeometry(true), coniferGeometry(true)];
  private gFarTree = [broadleafGeometry(false), coniferGeometry(false)];
  private mBuilding: THREE.MeshLambertMaterial;
  private mHouse: THREE.MeshLambertMaterial;
  private mSlab = new THREE.MeshLambertMaterial({ color: 0x8d8f92 });
  private mRibbon: THREE.MeshLambertMaterial;
  private mPad: THREE.MeshLambertMaterial;
  private mProp = new THREE.MeshLambertMaterial({ vertexColors: true });
  private mRotor: THREE.MeshLambertMaterial;
  private mTree: THREE.MeshLambertMaterial;
  private mFarTree: THREE.MeshLambertMaterial;
  private mWire = new THREE.LineBasicMaterial({ color: 0x1c1e20, transparent: true, opacity: 0.85 });
  private mGlow: THREE.ShaderMaterial;
  private padTex = helipadTexture();

  constructor(private engine: Engine, private pool: WorkerPool, private callbacks: PropCallbacks) {
    const night = this.night, time = engine.timeUniform;
    const q = engine.quality;

    // Buildings: one box per building, windows drawn by the shader.
    this.mBuilding = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.mBuilding.onBeforeCompile = (sh) => {
      sh.uniforms.uNight = night;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aStyle;\nvarying vec3 vLocal;\nvarying vec3 vFaceN;\nvarying vec2 vStyle;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vec3 bScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          vLocal = position * bScale;
          vFaceN = normal;
          vStyle = aStyle;`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float uNight;\nvarying vec3 vLocal;\nvarying vec3 vFaceN;\nvarying vec2 vStyle;\n${HASH_GLSL}`)
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          float bLit = 0.0;
          {
            float style = mod(vStyle.x, 8.0);
            float glassy = step(7.5, vStyle.x);
            vec3 wall = style < 0.5 ? vec3(0.52, 0.5, 0.46) : style < 1.5 ? vec3(0.62, 0.6, 0.57) : style < 2.5 ? vec3(0.42, 0.24, 0.18)
              : style < 3.5 ? vec3(0.36, 0.38, 0.41) : style < 4.5 ? vec3(0.66, 0.61, 0.5) : style < 5.5 ? vec3(0.3, 0.33, 0.36) : vec3(0.55, 0.56, 0.58);
            wall = mix(wall, vec3(0.46, 0.5, 0.55), glassy * 0.7);
            float top = step(0.5, vFaceN.y);
            vec2 uv = abs(vFaceN.x) > 0.5 ? vec2(vLocal.z, vLocal.y) : vec2(vLocal.x, vLocal.y);
            vec2 cell = mix(vec2(3.3, 3.5), vec2(2.5, 3.7), glassy);
            vec2 g = uv / cell;
            vec2 id = floor(g) + vFaceN.xz * 31.0;
            vec2 f = fract(g);
            vec2 lo = mix(vec2(0.2, 0.24), vec2(0.06, 0.1), glassy), hi = mix(vec2(0.8, 0.8), vec2(0.94, 0.9), glassy);
            float win = step(lo.x, f.x) * step(f.x, hi.x) * step(lo.y, f.y) * step(f.y, hi.y);
            float cover = (hi.x - lo.x) * (hi.y - lo.y);
            // Blend to the average once windows are smaller than a pixel.
            float px = max(fwidth(g.x), fwidth(g.y));
            float amt = mix(win, cover, smoothstep(0.3, 0.9, px));
            float h = hash12(id + vStyle.y * 0.37);
            // Glass: dark panes on masonry buildings, sky-tinted curtain wall on towers.
            vec3 glass = mix(vec3(0.16, 0.2, 0.26), vec3(0.34, 0.42, 0.5), h);
            glass = mix(glass, mix(vec3(0.38, 0.5, 0.62), vec3(0.6, 0.7, 0.8), h), glassy);
            vec3 col = mix(wall, glass, amt);
            col = mix(col, vec3(0.3, 0.3, 0.31), top);
            diffuseColor.rgb = pow(col, vec3(2.2));
            bLit = step(1.0 - 0.34 * uNight, hash12(id * 1.31 + vStyle.y)) * amt * (1.0 - top) * uNight * (0.45 + 0.55 * h);
          }`,
        )
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.76, 0.44) * bLit * 0.9;');
    };

    // Houses: walls and roof coloured per instance.
    this.mHouse = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.mHouse.onBeforeCompile = (sh) => {
      sh.uniforms.uNight = night;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aWall;\nattribute vec3 aRoof;\nattribute float part;\nvarying vec3 vHouse;\nvarying float vPart;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHouse = mix(aWall, aRoof, part);\nvPart = part;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying vec3 vHouse;\nvarying float vPart;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vHouse;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.74, 0.42) * 0.05 * uNight * (1.0 - vPart);');
    };

    // Roads and streets: asphalt with painted lines.
    this.mRibbon = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    this.mRibbon.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aRoad;\nvarying vec3 vRoad;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vRoad = aRoad;
          // Lift distant road a little so coarse terrain LODs do not swallow it.
          float rd = length((modelViewMatrix * vec4(position, 1.0)).xyz);
          transformed.y += max(0.0, rd - 250.0) * 0.0016;`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRoad;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            float across = vRoad.x, along = vRoad.y, kind = vRoad.z;
            float width = kind < 0.5 ? 9.0 : kind < 1.5 ? 8.4 : 17.0;
            vec3 col = kind < 0.5 ? vec3(0.019) : kind < 1.5 ? vec3(0.022) : vec3(0.015);
            float lw = 0.16 / width;
            float dash = step(0.5, fract(along / 12.0));
            float c = abs(across - 0.5);
            float white = 0.0, yellow = 0.0;
            if (kind < 0.5) {
              white = step(c, lw) * dash * 0.5;
            } else if (kind < 1.5) {
              white = step(c, lw) * dash + step(abs(c - 0.46), lw);
            } else {
              yellow = step(lw, c) * step(c, 3.0 * lw);
              white = step(abs(c - 0.25), lw) * dash + step(abs(c - 0.47), lw);
            }
            float fade = 1.0 - smoothstep(120.0, 520.0, length(vViewPosition));
            col = mix(col, vec3(0.62), clamp(white, 0.0, 1.0) * fade);
            col = mix(col, vec3(0.6, 0.42, 0.04), yellow * fade);
            diffuseColor.rgb = col;
          }`,
        );
    };

    this.mPad = new THREE.MeshLambertMaterial({ map: this.padTex });

    // Turbine rotors spin in the vertex shader.
    this.mRotor = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.mRotor.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = time;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          float ph = uTime * 1.25 + instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.11;
          float cs = cos(ph), sn = sin(ph);
          transformed.xy = mat2(cs, sn, -sn, cs) * transformed.xy;`,
        );
    };

    // Trees shrink away near the edge of their view radius, so they never pop.
    const treeMat = (near: number, far: number, inStart: number, inEnd: number) => {
      const m = new THREE.MeshLambertMaterial({ vertexColors: true });
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uFade = { value: new THREE.Vector4(near, far, inStart, inEnd) };
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nuniform vec4 uFade;')
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            vec3 tBase = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
            float tDist = distance(tBase.xz, cameraPosition.xz);
            transformed *= (1.0 - smoothstep(uFade.x, uFade.y, tDist)) * smoothstep(uFade.z, uFade.w, tDist);`,
          );
      };
      return m;
    };
    const tr = q.treeRadius;
    this.mTree = treeMat(tr * 0.8, tr, -2, -1);
    this.mFarTree = treeMat(PROPS.farTreeRadius * 0.8, PROPS.farTreeRadius, tr * 0.8, tr);

    // Street-light glow: additive points, only at night.
    this.mGlow = new THREE.ShaderMaterial({
      uniforms: { uNight: night, uFogDensity: this.fogDensity, uPixels: { value: 720 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float uPixels;
        uniform float uFogDensity;
        varying float vFade;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float d = length(mv.xyz);
          gl_PointSize = clamp(3.2 * uPixels / d, 1.6, 46.0);
          float f = uFogDensity * d;
          vFade = exp(-f * f);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uNight;
        varying float vFade;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float a = exp(-r * r * 4.5) * (1.0 - smoothstep(0.8, 1.0, r));
          gl_FragColor = vec4(vec3(1.0, 0.72, 0.38) * a * uNight * vFade * 1.6, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });

    this.group.matrixAutoUpdate = false;
    engine.scene.add(this.group);
    engine.onRebase(() => this.reposition());
  }

  get settled(): boolean {
    for (const r of this.structures.values()) if (!r.ready) return false;
    for (const r of this.forests.values()) if (!r.ready) return false;
    return true;
  }

  /** Stream cells in and out around the camera and refresh distance-based visibility. */
  update(x: number, y: number, z: number, nightAmount: number, fogDensity: number): void {
    this.cam.set(x, y, z);
    this.night.value = nightAmount;
    this.fogDensity.value = fogDensity;
    this.mGlow.uniforms.uPixels.value = this.engine.renderer.domElement.height;
    this.frame++;
    if (Math.hypot(x - this.lastX, z - this.lastZ) > 80) {
      this.lastX = x;
      this.lastZ = z;
      const q = this.engine.quality;
      this.stream(this.structures, PROPS.structureCell, q.buildingRadius, 'structures');
      this.stream(this.forests, PROPS.forestCell, q.treeRadius, 'forest');
    }
    if (this.frame % 8 === 0) this.refreshVisibility();
  }

  private stream(map: Map<string, CellRec>, size: number, radius: number, type: 'structures' | 'forest'): void {
    const cam = this.cam;
    const i0 = Math.floor((cam.x - radius) / size), i1 = Math.floor((cam.x + radius) / size);
    const j0 = Math.floor((cam.z - radius) / size), j1 = Math.floor((cam.z + radius) / size);
    const dist = (cx: number, cz: number) => Math.hypot((cx + 0.5) * size - cam.x, (cz + 0.5) * size - cam.z);
    for (let cz = j0; cz <= j1; cz++) {
      for (let cx = i0; cx <= i1; cx++) {
        if (dist(cx, cz) > radius + size * 0.5) continue;
        const key = cx + ',' + cz;
        if (map.has(key)) continue;
        const rec: CellRec = { key, cx, cz, x0: cx * size, z0: cz * size, group: null, parts: [], job: null, ready: false, disposables: [] };
        map.set(key, rec);
        const prio = () => Math.hypot((cx + 0.5) * size - this.cam.x, (cz + 0.5) * size - this.cam.z) * (type === 'forest' ? 1.2 : 0.35);
        rec.job = this.pool.submit(
          type === 'structures' ? { type, cx, cz } : { type, cx, cz, density: this.engine.quality.treeDensity },
          prio,
          (res) => {
            rec.job = null;
            rec.ready = true;
            if (res.type === 'structures') this.buildStructures(rec, res.cell);
            else if (res.type === 'forest') this.buildForest(rec, res.cell);
          },
        );
      }
    }
    for (const [key, rec] of map) {
      if (dist(rec.cx, rec.cz) > radius + size * 1.6) {
        this.disposeCell(rec, type === 'structures');
        map.delete(key);
      }
    }
    this.stats.structureCells = this.structures.size;
    this.stats.forestCells = this.forests.size;
  }

  private newGroup(rec: CellRec): THREE.Group {
    const g = new THREE.Group();
    g.matrixAutoUpdate = false;
    rec.group = g;
    this.place(rec);
    this.group.add(g);
    return g;
  }

  private place(rec: CellRec): void {
    if (!rec.group) return;
    rec.group.position.set(rec.x0 - this.engine.origin.x, 0, rec.z0 - this.engine.origin.z);
    rec.group.updateMatrix();
    rec.group.matrixWorldNeedsUpdate = true;
  }

  private reposition(): void {
    for (const r of this.structures.values()) this.place(r);
    for (const r of this.forests.values()) this.place(r);
  }

  private addPart(rec: CellRec, obj: THREE.Object3D, maxDist: number, night = false): void {
    obj.matrixAutoUpdate = false;
    rec.group!.add(obj);
    rec.parts.push({ obj, maxDist, night });
  }

  private instanced(rec: CellRec, geo: THREE.BufferGeometry, mat: THREE.Material, count: number, ownGeometry: boolean): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    rec.disposables.push(mesh);
    if (ownGeometry) rec.disposables.push(geo);
    return mesh;
  }

  private buildStructures(rec: CellRec, cell: StructureCell): void {
    this.callbacks.onStructures(rec.key, cell);
    const empty =
      cell.boxes.length + cell.houses.length + cell.slabs.length + cell.ribbonIndex.length + cell.pads.length + cell.pylons.length +
      cell.turbines.length + cell.boats.length + cell.farTrees.length === 0;
    if (empty) return;
    this.newGroup(rec);
    const q = this.engine.quality;

    let n = cell.boxes.length / BOX_STRIDE;
    if (n > 0) {
      const geo = this.gBox.clone();
      const style = new Float32Array(n * 2);
      const mesh = this.instanced(rec, geo, this.mBuilding, n, true);
      for (let i = 0; i < n; i++) {
        const o = i * BOX_STRIDE, b = cell.boxes;
        mesh.setMatrixAt(i, compose(b[o], b[o + 1], b[o + 2], b[o + 6], b[o + 3], b[o + 4], b[o + 5]));
        style[i * 2] = b[o + 7];
        style[i * 2 + 1] = b[o + 8];
      }
      geo.setAttribute('aStyle', new THREE.InstancedBufferAttribute(style, 2));
      mesh.castShadow = mesh.receiveShadow = true;
      this.addPart(rec, mesh, Infinity);
      this.stats.buildings += n;
    }

    n = cell.houses.length / HOUSE_STRIDE;
    if (n > 0) {
      const geo = this.gHouse.clone();
      const wall = new Float32Array(n * 3), roof = new Float32Array(n * 3);
      const mesh = this.instanced(rec, geo, this.mHouse, n, true);
      for (let i = 0; i < n; i++) {
        const o = i * HOUSE_STRIDE, h = cell.houses;
        mesh.setMatrixAt(i, compose(h[o], h[o + 1], h[o + 2], h[o + 6], h[o + 3], h[o + 4], h[o + 5]));
        WALLS[h[o + 7] % WALLS.length].toArray(wall, i * 3);
        ROOFS[h[o + 8] % ROOFS.length].toArray(roof, i * 3);
      }
      geo.setAttribute('aWall', new THREE.InstancedBufferAttribute(wall, 3));
      geo.setAttribute('aRoof', new THREE.InstancedBufferAttribute(roof, 3));
      mesh.castShadow = mesh.receiveShadow = true;
      this.addPart(rec, mesh, Math.min(q.buildingRadius, 4200));
      this.stats.buildings += n;
    }

    n = cell.slabs.length / SLAB_STRIDE;
    if (n > 0) {
      const mesh = this.instanced(rec, this.gSlab, this.mSlab, n, false);
      for (let i = 0; i < n; i++) {
        const o = i * SLAB_STRIDE, s = cell.slabs;
        mesh.setMatrixAt(i, compose(s[o], s[o + 1], s[o + 2], s[o + 6], s[o + 3], s[o + 4], s[o + 5]));
      }
      mesh.castShadow = true;
      this.addPart(rec, mesh, Infinity);
    }

    if (cell.ribbonIndex.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(cell.ribbonPos, 3));
      geo.setAttribute('aRoad', new THREE.BufferAttribute(cell.ribbonUv, 3));
      geo.setIndex(new THREE.BufferAttribute(cell.ribbonIndex, 1));
      // Roads are close to flat: a constant up normal is enough and saves computing them.
      const nrm = new Float32Array(cell.ribbonPos.length);
      for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      const mesh = new THREE.Mesh(geo, this.mRibbon);
      mesh.receiveShadow = true;
      rec.disposables.push(geo);
      this.addPart(rec, mesh, Math.min(q.buildingRadius, 6500));
    }

    n = cell.pads.length / PAD_STRIDE;
    if (n > 0) {
      const mesh = this.instanced(rec, this.gPad, this.mPad, n, false);
      for (let i = 0; i < n; i++) {
        const o = i * PAD_STRIDE, p = cell.pads;
        mesh.setMatrixAt(i, compose(p[o], p[o + 1], p[o + 2], p[o + 3], p[o + 4], 1, p[o + 4]));
      }
      mesh.receiveShadow = true;
      this.addPart(rec, mesh, 5000);
    }

    n = cell.lights.length / 3;
    if (n > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(cell.lights, 3));
      const pts = new THREE.Points(geo, this.mGlow);
      pts.frustumCulled = false;
      rec.disposables.push(geo);
      this.addPart(rec, pts, Math.min(q.buildingRadius, 6000), true);
      const poles = this.instanced(rec, this.gPole, this.mProp, n, false);
      for (let i = 0; i < n; i++) {
        const l = cell.lights;
        poles.setMatrixAt(i, compose(l[i * 3], l[i * 3 + 1] - 8.5, l[i * 3 + 2], (i * 2.399) % 6.283, 8.5, 8.5, 8.5));
      }
      this.addPart(rec, poles, q.detailRadius);
      this.stats.lights += n;
    }

    n = cell.pylons.length / POLE_STRIDE;
    if (n > 0) {
      const mesh = this.instanced(rec, this.gPylon, this.mProp, n, false);
      for (let i = 0; i < n; i++) {
        const o = i * POLE_STRIDE, p = cell.pylons;
        mesh.setMatrixAt(i, compose(p[o], p[o + 1], p[o + 2], p[o + 3], p[o + 4], p[o + 4], p[o + 4]));
      }
      mesh.castShadow = true;
      this.addPart(rec, mesh, 7000);
    }

    if (cell.wires.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(cell.wires, 3));
      const lines = new THREE.LineSegments(geo, this.mWire);
      lines.frustumCulled = false;
      rec.disposables.push(geo);
      this.addPart(rec, lines, 3500);
    }

    n = cell.turbines.length / POLE_STRIDE;
    if (n > 0) {
      const towers = this.instanced(rec, this.gTower, this.mProp, n, false);
      const rotors = this.instanced(rec, this.gRotor, this.mRotor, n, false);
      for (let i = 0; i < n; i++) {
        const o = i * POLE_STRIDE, t = cell.turbines;
        const H = t[o + 4], yaw = t[o + 3];
        towers.setMatrixAt(i, compose(t[o], t[o + 1], t[o + 2], yaw, H, H, H));
        // Hub sits just in front of the nacelle.
        rotors.setMatrixAt(i, compose(t[o] - Math.sin(yaw) * 0.04 * H, t[o + 1] + H, t[o + 2] - Math.cos(yaw) * 0.04 * H, yaw, H, H, H));
      }
      towers.castShadow = true;
      rotors.frustumCulled = false;
      this.addPart(rec, towers, Infinity);
      this.addPart(rec, rotors, Infinity);
    }

    n = cell.boats.length / BOAT_STRIDE;
    if (n > 0) {
      const mesh = this.instanced(rec, this.gBoat, this.mProp, n, false);
      for (let i = 0; i < n; i++) {
        const o = i * BOAT_STRIDE, b = cell.boats;
        mesh.setMatrixAt(i, compose(b[o], 0, b[o + 1], b[o + 2], b[o + 3], b[o + 3], b[o + 3]));
      }
      this.addPart(rec, mesh, 6000);
    }

    this.addTrees(rec, cell.farTrees, this.gFarTree, this.mFarTree, PROPS.farTreeRadius + PROPS.structureCell);
    for (const p of rec.parts) p.obj.updateMatrix();
  }

  private buildForest(rec: CellRec, cell: ForestCell): void {
    if (cell.trees.length === 0) return;
    this.newGroup(rec);
    this.addTrees(rec, cell.trees, this.gTree, this.mTree, Infinity);
    this.stats.trees += cell.trees.length / TREE_STRIDE;
  }

  private addTrees(rec: CellRec, trees: Float32Array, geos: THREE.BufferGeometry[], mat: THREE.Material, maxDist: number): void {
    const total = trees.length / TREE_STRIDE;
    if (total === 0) return;
    for (let type = 0; type < 2; type++) {
      let count = 0;
      for (let i = 0; i < total; i++) if (trees[i * TREE_STRIDE + 4] === type) count++;
      if (count === 0) continue;
      const mesh = this.instanced(rec, geos[type], mat, count, false);
      let k = 0;
      for (let i = 0; i < total; i++) {
        const o = i * TREE_STRIDE;
        if (trees[o + 4] !== type) continue;
        const s = trees[o + 3];
        const r = (trees[o] * 12.9898 + trees[o + 2] * 78.233) % 6.283;
        mesh.setMatrixAt(k, compose(trees[o], trees[o + 1], trees[o + 2], r, s, s * (0.9 + 0.2 * Math.abs(Math.sin(r * 3))), s));
        const v = 0.82 + 0.3 * Math.abs(Math.sin(r * 7.1));
        mesh.setColorAt(k, _c.setRGB(v, v * (0.96 + 0.08 * Math.sin(r * 5)), v * 0.9));
        k++;
      }
      mesh.castShadow = true;
      this.addPart(rec, mesh, maxDist);
    }
  }

  private refreshVisibility(): void {
    const cam = this.cam, C = PROPS.structureCell;
    const nightOn = this.night.value > 0.03;
    for (const rec of this.structures.values()) {
      if (!rec.group) continue;
      const d = Math.max(0, Math.hypot(rec.x0 + C / 2 - cam.x, rec.z0 + C / 2 - cam.z) - C * 0.71);
      for (const p of rec.parts) p.obj.visible = d < p.maxDist && (!p.night || nightOn);
    }
  }

  private disposeCell(rec: CellRec, structures: boolean): void {
    if (rec.job) rec.job.cancel();
    if (structures) this.callbacks.onRemove(rec.key);
    if (rec.group) this.group.remove(rec.group);
    for (const d of rec.disposables) d.dispose();
    rec.disposables.length = 0;
    rec.parts.length = 0;
    rec.group = null;
  }

  dispose(): void {
    for (const r of this.structures.values()) this.disposeCell(r, true);
    for (const r of this.forests.values()) this.disposeCell(r, false);
    this.structures.clear();
    this.forests.clear();
    this.engine.scene.remove(this.group);
  }
}
