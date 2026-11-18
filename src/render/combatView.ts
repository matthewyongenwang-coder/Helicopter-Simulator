import * as THREE from 'three';
import { COMPOUNDS } from '../data/weapons';
import { Owner, type Combat, type CombatEvent, type CompoundState, type PartState } from '../game/combat';
import { PartKind } from '../world/compounds';
import type { Effects } from './effects';
import type { Engine } from './engine';
import { merge, missileGeometry, paint } from './ordnance';

/**
 * Everything combat looks like: the compounds themselves, tracers, missiles
 * and their smoke, flares, impacts, and explosions from a 20 mm round's flash
 * up to a compound going up all at once.
 */

const C = {
  concrete: 0x9b968b,
  concreteDark: 0x75716a,
  sand: 0xb59f78,
  hesco: 0xa48f66,
  earth: 0x6f5f45,
  olive: 0x4d5338,
  oliveDark: 0x363a28,
  tarp: 0x56603f,
  metal: 0x2f3133,
  rust: 0x6a4b33,
  window: 0x1a1f23,
  tank: 0xc9c3b4,
  crate: 0x5c5a36,
  red: 0xb3221a,
};

const box = (w: number, h: number, d: number, x: number, y: number, z: number, col: number, ry = 0, rx = 0) =>
  paint(new THREE.BoxGeometry(w, h, d).rotateX(rx).rotateY(ry).translate(x, y, z), col);
const cyl = (rt: number, rb: number, h: number, x: number, y: number, z: number, col: number, seg = 12) =>
  paint(new THREE.CylinderGeometry(rt, rb, h, seg).translate(x, y, z), col);
/** A cylinder lying along +Z. */
const tube = (r: number, len: number, x: number, y: number, z: number, col: number, seg = 10) =>
  paint(new THREE.CylinderGeometry(r, r, len, seg).rotateX(Math.PI / 2).translate(x, y, z), col);

/** A ring of sandbags, `layers` high, with a firing gap at the front. */
function sandbags(radius: number, count: number, layers: number, y0 = 0): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let l = 0; l < layers; l++) {
    for (let k = 0; k < count; k++) {
      if (l === layers - 1 && k === 0) continue;
      const a = ((k + (l % 2) * 0.5) / count) * Math.PI * 2;
      out.push(box((2 * Math.PI * radius) / count + 0.08, 0.42, 0.6, Math.sin(a) * radius, y0 + 0.21 + l * 0.42, Math.cos(a) * radius, l % 2 ? C.sand : C.hesco, a));
    }
  }
  return out;
}

interface PartGeometry {
  body: THREE.BufferGeometry;
  /** A turning mount: yaw pivot height, then the elevating part above it. */
  yaw?: THREE.BufferGeometry;
  pitch?: THREE.BufferGeometry;
  yawY?: number;
  pitchY?: number;
  /** The mount spins on its own (radar). */
  spin?: boolean;
}

function buildPart(kind: PartKind): PartGeometry {
  switch (kind) {
    case PartKind.Command: {
      const g = [box(16.4, 2.8, 11.4, 0, -1.3, 0, C.concreteDark), box(16, 6.8, 11, 0, 3.4, 0, C.concrete), box(16.3, 0.5, 11.3, 0, 7.0, 0, C.concreteDark)];
      for (let i = -3; i <= 3; i++) {
        for (const y of [1.9, 4.9]) for (const s of [-1, 1]) g.push(box(1.2, 0.9, 0.08, i * 2.15, y, s * 5.52, C.window));
      }
      for (const s of [-1, 1]) for (const k of [-1, 1]) g.push(box(0.08, 0.9, 1.2, s * 8.02, 4.9, k * 2.4, C.window));
      g.push(box(2, 2.5, 0.1, 0, 1.25, 5.54, C.metal));
      g.push(...sandbags(1.7, 10, 2, 7.25).map((b) => b.translate(4.2, 0, -2.4)));
      g.push(cyl(1.1, 1.1, 1.8, -4.5, 8.15, 2.5, C.tank), cyl(0.06, 0.06, 8, -5.8, 11.2, -3.6, C.metal, 6));
      g.push(paint(new THREE.CylinderGeometry(1.0, 0.2, 0.3, 14).rotateX(-0.9).translate(-1.5, 8.2, -3.2), C.tank));
      return { body: merge(g) };
    }
    case PartKind.Barracks: {
      const g = [box(18.2, 2.5, 7.4, 0, -1.2, 0, C.concreteDark), box(18, 3.6, 7, 0, 1.8, 0, C.sand), box(18.8, 0.3, 7.8, 0, 3.75, 0, C.rust), box(18.8, 0.5, 3.4, 0, 4.1, 0, C.rust)];
      for (let i = -3; i <= 3; i++) for (const s of [-1, 1]) g.push(box(1.0, 0.8, 0.08, i * 2.5, 2.2, s * 3.52, C.window));
      g.push(box(0.1, 2.2, 1.4, 9.02, 1.1, 0, C.metal));
      return { body: merge(g) };
    }
    case PartKind.Depot: {
      const g = [paint(new THREE.CylinderGeometry(4.0, 5.2, 2.2, 10, 1, true).translate(0, 0.6, 0), C.earth), box(6.2, 2.4, 5.6, 0, 1.0, 0, C.tarp), box(6.6, 0.4, 6.0, 0, 2.35, 0, C.tarp)];
      for (const [x, z] of [[-3.9, 3.6], [-2.4, 3.9], [3.5, -3.8], [3.9, -2.2]]) g.push(box(1.3, 1.0, 1.3, x, 0.5, z, C.crate), box(1.1, 0.9, 1.1, x, 1.45, z, C.crate));
      return { body: merge(g) };
    }
    case PartKind.Tanks: {
      const g = [box(10.8, 0.6, 5.2, 0, 0, 0, C.concreteDark)];
      for (const s of [-1, 1]) {
        g.push(cyl(2.1, 2.1, 4.2, s * 2.55, 2.4, 0, C.tank, 18));
        g.push(paint(new THREE.SphereGeometry(2.1, 18, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.25, 1).translate(s * 2.55, 4.5, 0), C.tank));
        g.push(box(0.12, 4.4, 0.12, s * 2.55 + s * 2.1, 2.3, 0, C.metal));
      }
      g.push(tube(0.18, 4.2, 0, 0.8, 1.2, C.metal).rotateY(Math.PI / 2));
      return { body: merge(g) };
    }
    case PartKind.Sam: {
      const body = merge([box(6.6, 1.1, 3.0, 0, 0.75, 0, C.olive), box(6.9, 0.9, 0.62, 0, 0.45, 1.3, C.metal), box(6.9, 0.9, 0.62, 0, 0.45, -1.3, C.metal), box(1.6, 0.9, 2.6, 2.6, 1.7, 0, C.oliveDark)]);
      const yaw = merge([cyl(1.0, 1.15, 0.5, 0, 0.25, 0, C.oliveDark, 14), box(0.5, 1.0, 0.9, -0.95, 0.9, 0, C.olive), box(0.5, 1.0, 0.9, 0.95, 0.9, 0, C.olive)]);
      const tubes: THREE.BufferGeometry[] = [box(1.5, 0.22, 1.4, 0, -0.1, 0.4, C.oliveDark)];
      for (const x of [-0.36, 0.36]) for (const y of [0.25, 0.85]) tubes.push(tube(0.28, 4.6, x, y, 0.8, C.olive, 12), tube(0.24, 0.05, x, y, 3.11, C.metal, 12));
      return { body, yaw, pitch: merge(tubes), yawY: 1.3, pitchY: 1.15 };
    }
    case PartKind.Radar: {
      const body = merge([box(3.2, 2.4, 3.2, 0, 1.2, 0, C.olive), box(3.4, 0.2, 3.4, 0, 2.5, 0, C.oliveDark), box(0.35, 4.6, 0.35, 0, 4.8, 0, C.metal)]);
      const dish = merge([
        paint(new THREE.CylinderGeometry(1.8, 1.2, 0.35, 18, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.3), C.tank),
        paint(new THREE.CircleGeometry(1.2, 18).translate(0, 0, 0.12), C.tank),
        box(0.08, 0.08, 1.4, 0, 0, 0.9, C.metal),
        box(0.6, 0.5, 0.5, 0, 0, -0.3, C.metal),
      ]);
      return { body, yaw: dish, yawY: 7.2, spin: true };
    }
    case PartKind.Aaa: {
      const body = merge(sandbags(2.15, 12, 2));
      const yaw = merge([cyl(0.7, 0.85, 0.7, 0, 0.35, 0, C.oliveDark, 12), box(0.5, 0.6, 0.5, 0.75, 0.8, -0.4, C.metal)]);
      const pitch = merge([box(0.9, 0.55, 1.4, 0, 0, 0, C.olive), tube(0.07, 3.2, -0.24, 0.05, 1.9, C.metal, 8), tube(0.07, 3.2, 0.24, 0.05, 1.9, C.metal, 8), tube(0.11, 0.5, -0.24, 0.05, 3.3, C.metal, 8), tube(0.11, 0.5, 0.24, 0.05, 3.3, C.metal, 8)]);
      return { body, yaw, pitch, yawY: 0.1, pitchY: 1.3 };
    }
    case PartKind.Mg: {
      const body = merge(sandbags(1.75, 10, 2));
      const yaw = merge([cyl(0.05, 0.05, 0.9, 0, 0.45, 0, C.metal, 6)]);
      const pitch = merge([box(0.24, 0.24, 0.75, 0, 0, 0.1, C.metal), tube(0.045, 1.3, 0, 0.02, 1.1, C.metal, 6), box(0.05, 0.3, 0.05, 0, -0.2, 0.9, C.metal)]);
      return { body, yaw, pitch, yawY: 0.2, pitchY: 1.05 };
    }
    case PartKind.Tower: {
      const g: THREE.BufferGeometry[] = [box(4.2, 0.5, 4.2, 0, 0, 0, C.concreteDark)];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.push(box(0.26, 7.4, 0.26, sx * 1.55, 3.7, sz * 1.55, C.rust));
      for (const s of [-1, 1]) {
        g.push(box(0.12, 4.4, 0.12, s * 1.55, 3.4, 0, C.rust, 0, 0.78), box(0.12, 4.4, 0.12, 0, 3.4, s * 1.55, C.rust, Math.PI / 2, 0.78));
        g.push(box(3.9, 1.1, 0.14, 0, 8.0, s * 1.88, C.hesco), box(0.14, 1.1, 3.9, s * 1.88, 8.0, 0, C.hesco));
      }
      g.push(box(3.9, 0.3, 3.9, 0, 7.35, 0, C.rust), box(4.3, 0.2, 4.3, 0, 9.9, 0, C.rust));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.push(box(0.12, 2.4, 0.12, sx * 1.85, 8.7, sz * 1.85, C.rust));
      const yaw = merge([cyl(0.05, 0.05, 0.8, 0, 0.4, 0, C.metal, 6)]);
      const pitch = merge([box(0.24, 0.24, 0.75, 0, 0, 0.1, C.metal), tube(0.045, 1.3, 0, 0.02, 1.1, C.metal, 6)]);
      return { body: merge(g), yaw, pitch, yawY: 7.5, pitchY: 1.2 };
    }
    case PartKind.Truck:
    default: {
      const g = [box(2.3, 0.45, 7.0, 0, 0.95, 0, C.metal), box(2.4, 2.0, 2.0, 0, 2.0, -2.5, C.olive), box(2.2, 0.7, 0.08, 0, 2.5, -3.52, C.window), box(2.5, 0.8, 4.6, 0, 1.6, 1.0, C.olive), box(2.5, 1.5, 4.4, 0, 2.75, 1.05, C.tarp)];
      for (const z of [-2.5, 0.8, 2.4]) for (const s of [-1, 1]) g.push(paint(new THREE.CylinderGeometry(0.52, 0.52, 0.42, 12).rotateZ(Math.PI / 2).translate(s * 1.1, 0.52, z), 0x1b1c1d));
      return { body: merge(g) };
    }
  }
}

interface PartView {
  state: PartState;
  group: THREE.Group;
  body: THREE.Mesh;
  yaw: THREE.Mesh | null;
  pitch: THREE.Mesh | null;
  spin: boolean;
  dead: boolean;
}

interface CompoundView {
  state: CompoundState;
  group: THREE.Group;
  parts: PartView[];
  walls: THREE.Mesh;
  flag: THREE.Group;
  cloth: THREE.Object3D;
  dead: boolean;
}

interface Debris {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ax: number;
  ay: number;
  az: number;
  spin: number;
  size: number;
  age: number;
  life: number;
  burning: boolean;
  resting: boolean;
}

interface Fire {
  x: number;
  y: number;
  z: number;
  until: number;
  rate: number;
  size: number;
  acc: number;
  /** A tall dark column visible from far away. */
  column: boolean;
}

interface Burst {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  ring: boolean;
  x: number;
  y: number;
  z: number;
  age: number;
  life: number;
  r0: number;
  r1: number;
  alpha: number;
  /** Fraction of the life spent at full brightness, and climb rate (m/s). */
  hold: number;
  rise: number;
}

const FIREBALL_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vP;
  varying vec3 vV;
  void main() {
    vP = position;
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;

const FIREBALL_FRAG = /* glsl */ `
  uniform float uT;
  uniform float uAlpha;
  uniform float uHot;
  uniform vec3 uCol;
  varying vec3 vN;
  varying vec3 vP;
  varying vec3 vV;
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  void main() {
    float fr = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
    float n = noise(vP * 3.2 + vec3(0.0, -uT * 2.5, uT)) * 0.6 + noise(vP * 7.5 - uT * 3.0) * 0.4;
    vec3 c = mix(uCol, vec3(1.0, 0.94, 0.72), pow(fr, 2.0) * uHot) * (0.55 + 0.9 * n);
    float a = uAlpha * smoothstep(0.0, 0.55, fr) * (0.45 + 0.55 * n);
    gl_FragColor = vec4(c, a);
  }`;

const RING_FRAG = /* glsl */ `
  uniform float uAlpha;
  uniform vec3 uCol;
  varying vec3 vP;
  void main() {
    float r = length(vP.xy);
    float a = smoothstep(0.55, 0.96, r) * (1.0 - smoothstep(0.96, 1.0, r)) * uAlpha;
    gl_FragColor = vec4(uCol, a);
  }`;

const MAX_TRACERS = 600;
const MAX_DEBRIS = 220;

export class CombatView {
  /** Camera shake to add this frame (read and cleared by the game). */
  kick = 0;
  /** A flash across the screen after a big blast nearby, 0–1. */
  screenFlash = 0;

  private views = new Map<string, CompoundView>();
  private partGeo = new Map<PartKind, PartGeometry>();
  private mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.04 });
  private gunMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35 });
  private poleMat = new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.5, metalness: 0.5 });
  private charMat = new THREE.MeshStandardMaterial({ color: 0x1b1816, roughness: 1, metalness: 0 });
  private flagMat = new THREE.MeshStandardMaterial({ color: C.red, roughness: 0.8, side: THREE.DoubleSide });
  private poleGeo = new THREE.CylinderGeometry(0.06, 0.08, 10, 6).translate(0, 5, 0);
  private clothGeo = new THREE.PlaneGeometry(2.6, 1.6, 6, 2).translate(1.3, 0, 0);

  private tracerGeo = new THREE.BufferGeometry();
  private tracerPos = new Float32Array(MAX_TRACERS * 4 * 3);
  private tracerCol = new Float32Array(MAX_TRACERS * 4 * 3);
  private tracers: THREE.Mesh;

  private missileGeo = missileGeometry();
  private missileMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3 });
  private missileMeshes: THREE.Mesh[] = [];
  private trailAcc = new WeakMap<object, number>();

  private debris: Debris[] = [];
  private debrisMesh: THREE.InstancedMesh;
  private fires: Fire[] = [];
  private bursts: Burst[] = [];
  private burstSphere = new THREE.SphereGeometry(1, 32, 20);
  private burstRing = new THREE.RingGeometry(0.55, 1, 96, 1);
  private timeline: { t: number; fn: () => void }[] = [];
  readonly light = new THREE.PointLight(0xffa860, 0, 3500, 1.25);
  private time = 0;
  private m4 = new THREE.Matrix4();
  private q4 = new THREE.Quaternion();
  private v3 = new THREE.Vector3();
  private s3 = new THREE.Vector3();
  private e3 = new THREE.Euler();
  private fwd = new THREE.Vector3(0, 0, -1);
  private cam = { x: 0, y: 0, z: 0 };
  private rnd = Math.random;

  constructor(private engine: Engine, private fx: Effects, private combat: Combat, private ground: (x: number, z: number) => number) {
    const ig = new Uint32Array(MAX_TRACERS * 6);
    for (let i = 0; i < MAX_TRACERS; i++) ig.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    this.tracerGeo.setIndex(new THREE.BufferAttribute(ig, 1));
    this.tracerGeo.setAttribute('position', new THREE.BufferAttribute(this.tracerPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.tracerGeo.setAttribute('color', new THREE.BufferAttribute(this.tracerCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.tracers = new THREE.Mesh(this.tracerGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, toneMapped: false }));
    this.tracers.frustumCulled = false;
    this.tracers.renderOrder = 35;
    engine.scene.add(this.tracers);

    this.debrisMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x2b2723, roughness: 0.95 }), MAX_DEBRIS);
    this.debrisMesh.count = 0;
    this.debrisMesh.frustumCulled = false;
    this.debrisMesh.castShadow = true;
    engine.scene.add(this.debrisMesh);
    engine.scene.add(this.light);
  }

  /** Forget what is in the air (respawn). Compounds and their fires stay. */
  reset(): void {
    for (const m of this.missileMeshes) m.visible = false;
    this.screenFlash = 0;
    this.kick = 0;
  }

  update(dt: number, events: CombatEvent[], camX: number, camY: number, camZ: number): void {
    this.time += dt;
    this.cam.x = camX;
    this.cam.y = camY;
    this.cam.z = camZ;
    for (const e of events) this.onEvent(e);
    this.syncCompounds(dt);
    this.drawTracers();
    this.drawMissiles(dt);
    this.drawFlares(dt);
    this.runTimeline(dt);
    this.updateDebris(dt);
    this.updateFires(dt);
    this.updateBursts(dt);
    this.light.intensity *= Math.exp(-dt * 4.5);
    if (this.light.intensity < 1) this.light.intensity = 0;
    this.screenFlash *= Math.exp(-dt * 3.2);
  }

  // ---- Compounds ---------------------------------------------------------------------

  private geometry(kind: PartKind): PartGeometry {
    let g = this.partGeo.get(kind);
    if (!g) {
      g = buildPart(kind);
      this.partGeo.set(kind, g);
    }
    return g;
  }

  private build(c: CompoundState): CompoundView {
    const s = c.site;
    const group = new THREE.Group();
    const parts: PartView[] = c.parts.map((ps) => {
      const geo = this.geometry(ps.def.kind);
      const pg = new THREE.Group();
      pg.position.set(ps.def.x - s.x, ps.def.y, ps.def.z - s.z);
      pg.rotation.y = ps.def.yaw;
      const body = new THREE.Mesh(geo.body, this.mat);
      body.castShadow = body.receiveShadow = true;
      pg.add(body);
      let yaw: THREE.Mesh | null = null, pitch: THREE.Mesh | null = null;
      if (geo.yaw) {
        yaw = new THREE.Mesh(geo.yaw, this.gunMat);
        yaw.position.y = geo.yawY ?? 0;
        yaw.castShadow = true;
        pg.add(yaw);
        if (geo.pitch) {
          pitch = new THREE.Mesh(geo.pitch, this.gunMat);
          pitch.position.y = geo.pitchY ?? 0;
          pitch.castShadow = true;
          yaw.add(pitch);
        }
      }
      group.add(pg);
      return { state: ps, group: pg, body, yaw, pitch, spin: !!geo.spin, dead: false };
    });
    // Perimeter: earth-filled barriers in sections that follow the ground.
    const wg: THREE.BufferGeometry[] = [];
    for (const w of s.walls) {
      const n = Math.max(1, Math.round(w.len / 1.6));
      const c0 = Math.cos(w.yaw), s0 = Math.sin(w.yaw);
      for (let k = 0; k < n; k++) {
        const along = -w.len / 2 + (k + 0.5) * (w.len / n);
        wg.push(box(w.len / n - 0.06, 3.6, 1.5, w.x - s.x + along * c0, w.y + 0.6, w.z - s.z - along * s0, k % 2 ? C.hesco : C.sand, w.yaw));
      }
    }
    const walls = new THREE.Mesh(merge(wg), this.mat);
    walls.castShadow = walls.receiveShadow = true;
    group.add(walls);
    const flag = new THREE.Group();
    flag.position.set(s.flag.x - s.x, s.flag.y, s.flag.z - s.z);
    const pole = new THREE.Mesh(this.poleGeo, this.poleMat);
    pole.castShadow = true;
    const cloth = new THREE.Mesh(this.clothGeo, this.flagMat);
    cloth.position.y = 9.1;
    cloth.castShadow = true;
    flag.add(pole, cloth);
    group.add(flag);
    this.engine.scene.add(group);
    const v: CompoundView = { state: c, group, parts, walls, flag, cloth, dead: false };
    // Coming back to one already destroyed: a burnt-out ruin.
    if (c.destroyed) this.ruin(v, false);
    return v;
  }

  private dispose(v: CompoundView): void {
    this.engine.scene.remove(v.group);
    v.walls.geometry.dispose();
  }

  private charPart(pv: PartView): void {
    if (pv.dead) return;
    pv.dead = true;
    pv.body.material = this.charMat;
    const k = pv.state.def.kind;
    // Buildings slump; vehicles and guns keel over.
    if (k === PartKind.Command || k === PartKind.Barracks || k === PartKind.Depot || k === PartKind.Tanks) pv.body.scale.set(1.02, 0.42, 1.02);
    else if (k === PartKind.Tower) {
      pv.group.rotation.z = 0.35 + this.rnd() * 0.3;
      pv.body.scale.y = 0.8;
    } else pv.group.rotation.z = (this.rnd() - 0.5) * 0.5;
    if (pv.yaw) {
      pv.yaw.material = this.charMat;
      pv.yaw.rotation.z = 0.6;
      if (pv.pitch) pv.pitch.material = this.charMat;
    }
  }

  private ruin(v: CompoundView, fresh: boolean): void {
    v.dead = true;
    for (const pv of v.parts) this.charPart(pv);
    v.walls.material = this.charMat;
    v.flag.visible = false;
    const s = v.state.site;
    // A column of smoke that marks the ruin for a long time.
    this.fires.push({ x: s.x, y: s.y + 4, z: s.z, until: this.time + (fresh ? 150 : 60), rate: fresh ? 6 : 2.5, size: fresh ? 1.6 : 1, acc: 0, column: true });
  }

  private syncCompounds(dt: number): void {
    const o = this.engine.origin;
    const live = new Set<string>();
    for (const c of this.combat.active) {
      if (c.dist > COMPOUNDS.activeRange) continue;
      live.add(c.site.id);
      if (!this.views.has(c.site.id)) this.views.set(c.site.id, this.build(c));
    }
    for (const [id, v] of this.views) {
      const s = v.state.site;
      const d = Math.hypot(s.x - this.cam.x, s.z - this.cam.z);
      if (!live.has(id) && d > COMPOUNDS.dropRange) {
        this.dispose(v);
        this.views.delete(id);
        continue;
      }
      v.group.position.set(s.x - o.x, 0, s.z - o.z);
      if (v.state.destroyed && !v.dead) this.ruin(v, true);
      // Turn the guns and launchers, flutter the flag, spin the radar.
      const near = d < 2500;
      for (const pv of v.parts) {
        if (pv.state.dead) {
          if (!pv.dead) this.charPart(pv);
          continue;
        }
        if (!near || !pv.yaw) continue;
        if (pv.spin) pv.yaw.rotation.y += dt * 1.6;
        else {
          pv.yaw.rotation.y = pv.state.aimYaw - pv.state.def.yaw;
          if (pv.pitch) {
            const min = pv.state.def.kind === PartKind.Sam ? 0.18 : -0.15;
            pv.pitch.rotation.x = -Math.max(min, Math.min(1.25, pv.state.aimPitch));
          }
        }
      }
      if (near && !v.dead) v.cloth.rotation.y = Math.sin(this.time * 2.3 + s.x) * 0.35 + 0.4;
    }
  }

  // ---- Things in flight ----------------------------------------------------------------

  private drawTracers(): void {
    const o = this.engine.origin, cam = this.cam;
    const P = this.tracerPos, Cc = this.tracerCol;
    let n = 0;
    for (const b of this.combat.bullets) {
      if (!b.tracer || n >= MAX_TRACERS) continue;
      const sp = Math.hypot(b.vx, b.vy, b.vz) || 1;
      const len = Math.min(40, sp * 0.035);
      const ux = b.vx / sp, uy = b.vy / sp, uz = b.vz / sp;
      const hx = b.x, hy = b.y, hz = b.z;
      const tx = hx - ux * len, ty = hy - uy * len, tz = hz - uz * len;
      // Widen across the line of sight, never thinner than a couple of pixels.
      const vx = hx - cam.x, vy = hy - cam.y, vz = hz - cam.z;
      const dist = Math.hypot(vx, vy, vz);
      let sx = uy * vz - uz * vy, sy = uz * vx - ux * vz, sz = ux * vy - uy * vx;
      const sl = Math.hypot(sx, sy, sz) || 1;
      const w = Math.max(b.owner === Owner.Player ? 0.07 : 0.1, dist * 0.0011);
      sx = (sx / sl) * w; sy = (sy / sl) * w; sz = (sz / sl) * w;
      const i = n * 12;
      P[i] = hx - sx - o.x; P[i + 1] = hy - sy; P[i + 2] = hz - sz - o.z;
      P[i + 3] = hx + sx - o.x; P[i + 4] = hy + sy; P[i + 5] = hz + sz - o.z;
      P[i + 6] = tx - sx - o.x; P[i + 7] = ty - sy; P[i + 8] = tz - sz - o.z;
      P[i + 9] = tx + sx - o.x; P[i + 10] = ty + sy; P[i + 11] = tz + sz - o.z;
      const r = 1, g = b.owner === Owner.Player ? 0.82 : b.owner === Owner.Aaa ? 0.62 : 0.3, bb = b.owner === Owner.Player ? 0.45 : b.owner === Owner.Aaa ? 0.22 : 0.16;
      Cc[i] = Cc[i + 3] = r; Cc[i + 1] = Cc[i + 4] = g; Cc[i + 2] = Cc[i + 5] = bb;
      Cc[i + 6] = Cc[i + 9] = r * 0.05; Cc[i + 7] = Cc[i + 10] = g * 0.02; Cc[i + 8] = Cc[i + 11] = 0;
      n++;
    }
    this.tracerGeo.setDrawRange(0, n * 6);
    (this.tracerGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.tracerGeo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.tracers.visible = n > 0;
  }

  private drawMissiles(dt: number): void {
    const o = this.engine.origin, fx = this.fx;
    const list = this.combat.missiles;
    while (this.missileMeshes.length < list.length) {
      const m = new THREE.Mesh(this.missileGeo, this.missileMat);
      m.castShadow = true;
      this.engine.scene.add(m);
      this.missileMeshes.push(m);
    }
    this.missileMeshes.forEach((mesh, i) => {
      const m = list[i];
      mesh.visible = !!m;
      if (!m) return;
      mesh.position.set(m.x - o.x, m.y, m.z - o.z);
      this.v3.set(m.dx, m.dy, m.dz);
      mesh.quaternion.setFromUnitVectors(this.fwd, this.v3);
      mesh.scale.setScalar(m.enemy ? 1.9 : 1);
      if (m.age < m.delay || dt <= 0) return;
      // Motor flame and a smoke trail laid every few metres.
      const L = m.enemy ? 1.6 : 0.85;
      const bx = m.x - m.dx * L, by = m.y - m.dy * L, bz = m.z - m.dz * L;
      if (m.age > m.delay + 6) return;
      fx.glow(bx, by, bz, -m.dx * 20, -m.dy * 20, -m.dz * 20, 0.06, m.enemy ? 2.6 : 1.6, 0.6, 1, 0.78, 0.45, 1, 4);
      let acc = (this.trailAcc.get(m) ?? 0) + m.speed * dt;
      while (acc > 5) {
        acc -= 5;
        const back = acc;
        fx.smoke(bx - m.dx * back, by - m.dy * back, bz - m.dz * back, (this.rnd() - 0.5) * 1.5, (this.rnd() - 0.5) * 1.5 + 0.4, (this.rnd() - 0.5) * 1.5, 3.2 + this.rnd() * 1.6, 0.9, m.enemy ? 6.5 : 4.5, 0.86, 0.85, 0.83, 0.42, 0.5, 0.3);
      }
      this.trailAcc.set(m, acc);
    });
  }

  private drawFlares(dt: number): void {
    if (dt <= 0) return;
    const fx = this.fx, r = this.rnd;
    for (const f of this.combat.flares) {
      const k = 1 - f.age / f.life;
      fx.glow(f.x, f.y, f.z, f.vx * 0.3, f.vy * 0.3, f.vz * 0.3, 0.07, 3.2 * k + 0.8, 1.2, 1, 0.92, 0.72, 1, 2);
      fx.glow(f.x, f.y, f.z, (r() - 0.5) * 6, (r() - 0.5) * 6, (r() - 0.5) * 6, 0.25, 0.5, 0.1, 1, 0.65, 0.3, 0.9, 1, -6);
      if (r() < 0.7) fx.smoke(f.x, f.y, f.z, f.vx * 0.15, f.vy * 0.15, f.vz * 0.15, 2.2 + r(), 0.5, 3.4, 0.95, 0.95, 0.95, 0.34, 0.9, 0.6);
    }
  }

  // ---- Events -------------------------------------------------------------------------

  private onEvent(e: CombatEvent): void {
    const fx = this.fx, r = this.rnd;
    switch (e.type) {
      case 'gunFire':
        fx.glow(e.x, e.y, e.z, 0, 0, 0, 0.05, 1.1, 0.4, 1, 0.8, 0.4, 1, 0);
        if (r() < 0.4) fx.smoke(e.x, e.y, e.z, 0, 0.5, 0, 0.8, 0.3, 1.6, 0.8, 0.8, 0.78, 0.25, 1.5, 0.3);
        break;
      case 'enemyFire': {
        const d = Math.hypot(e.x - this.cam.x, e.y - this.cam.y, e.z - this.cam.z);
        fx.glow(e.x, e.y, e.z, 0, 0, 0, 0.06, Math.max(0.9, d * 0.005), 0.3, 1, 0.7, 0.35, 1, 0);
        if (e.kind === Owner.Aaa) fx.smoke(e.x, e.y, e.z, 0, 0.8, 0, 1.4, 0.6, 3, 0.7, 0.68, 0.64, 0.3, 1, 0.4);
        break;
      }
      case 'impact':
        if (e.water) {
          for (let k = 0; k < 3; k++) fx.smoke(e.x, e.y + 0.2, e.z, (r() - 0.5) * 2, 5 + r() * 6, (r() - 0.5) * 2, 0.9 + r() * 0.5, 0.4, 2.2, 0.9, 0.93, 0.96, 0.6, 0.6, -6);
        } else if (e.hit) {
          for (let k = 0; k < 5; k++) fx.glow(e.x, e.y, e.z, (r() - 0.5) * 22, r() * 14, (r() - 0.5) * 22, 0.2 + r() * 0.25, 0.25, 0.05, 1, 0.75, 0.35, 1, 0.5, -9);
          fx.smoke(e.x, e.y, e.z, 0, 1.5, 0, 1.4, 0.6, 3.2, 0.3, 0.29, 0.27, 0.55, 0.8, 0.8);
          if (e.player) fx.glow(e.x, e.y, e.z, 0, 0, 0, 0.07, 1.8, 0.6, 1, 0.7, 0.3, 1, 0);
        } else {
          for (let k = 0; k < 2; k++) fx.smoke(e.x, e.y + 0.3, e.z, (r() - 0.5) * 3, 2 + r() * 4, (r() - 0.5) * 3, 1.0 + r() * 0.8, 0.5, 2.6, 0.5, 0.44, 0.35, 0.55, 0.9, -3);
          if (e.player) fx.glow(e.x, e.y + 0.3, e.z, 0, 0, 0, 0.06, 1.4, 0.4, 1, 0.7, 0.3, 0.9, 0);
        }
        break;
      case 'flak':
        fx.glow(e.x, e.y, e.z, 0, 0, 0, 0.09, 4, 2, 1, 0.65, 0.3, 1, 0);
        for (let k = 0; k < 4; k++) fx.smoke(e.x + (r() - 0.5) * 2, e.y + (r() - 0.5) * 2, e.z + (r() - 0.5) * 2, (r() - 0.5) * 4, (r() - 0.5) * 4, (r() - 0.5) * 4, 3 + r() * 2, 2, 7, 0.07, 0.065, 0.06, 0.8, 1.2, 0.2);
        this.shake(e.x, e.y, e.z, 0.25);
        break;
      case 'explosion':
        this.explode(e.x, e.y, e.z, e.size);
        break;
      case 'partDestroyed':
        this.explode(e.x, e.y + 1, e.z, e.size);
        this.throwDebris(e.x, e.y + 1, e.z, Math.round(6 + e.size * 8), e.size);
        this.fires.push({ x: e.x, y: e.y + e.part.type.hy * 0.8, z: e.z, until: this.time + 40 + r() * 50, rate: 10 * e.size, size: 0.6 + e.size * 0.5, acc: 0, column: false });
        break;
      case 'compoundDestroyed':
        this.megaExplosion(e.compound);
        break;
      case 'missileLaunch':
        for (let k = 0; k < (e.enemy ? 14 : 5); k++) fx.smoke(e.x, e.y, e.z, (r() - 0.5) * 6, r() * 3, (r() - 0.5) * 6, 2.5 + r() * 2, 1, e.enemy ? 8 : 4, 0.85, 0.84, 0.82, 0.5, 0.8, 0.5);
        fx.glow(e.x, e.y, e.z, 0, 0, 0, 0.12, e.enemy ? 5 : 2.5, 1, 1, 0.75, 0.4, 1, 0);
        break;
      case 'flare':
        fx.glow(e.x, e.y, e.z, 0, 0, 0, 0.08, 2.5, 0.8, 1, 0.95, 0.85, 1, 0);
        break;
      default:
        break;
    }
  }

  private shake(x: number, y: number, z: number, amount: number): void {
    const d = Math.hypot(x - this.cam.x, y - this.cam.y, z - this.cam.z);
    this.kick = Math.max(this.kick, (amount * 120) / (120 + d));
  }

  /** A blast of a given size (1 ≈ a missile warhead). */
  private explode(x: number, y: number, z: number, s: number): void {
    const fx = this.fx, r = this.rnd;
    const g = this.ground(x, z);
    const nFire = Math.min(140, Math.round(22 * s * s + 14));
    for (let i = 0; i < nFire; i++) {
      const a = r() * Math.PI * 2, e = Math.asin(r() * 2 - 1), sp = (3 + 11 * r()) * Math.sqrt(s);
      fx.glow(x, y, z, Math.cos(a) * Math.cos(e) * sp, Math.abs(Math.sin(e)) * sp * 0.9 + 2, Math.sin(a) * Math.cos(e) * sp, (0.45 + 0.6 * r()) * (0.7 + 0.3 * s), 1.2 * s, (3.5 + 4 * r()) * s, 1, 0.38 + 0.3 * r(), 0.08 + 0.06 * r(), 0.95, 2.4, 3.5);
    }
    for (let i = 0; i < Math.round(10 * s + 4); i++) {
      const a = r() * Math.PI * 2, sp = 25 + 45 * r();
      fx.glow(x, y, z, Math.cos(a) * sp * 0.7, 10 + r() * 30, Math.sin(a) * sp * 0.7, 0.6 + r() * 0.8, 0.35, 0.12, 1, 0.78, 0.4, 1, 0.5, -9.8);
    }
    const nSmoke = Math.min(90, Math.round(14 * s * s + 8));
    for (let i = 0; i < nSmoke; i++) {
      const a = r() * Math.PI * 2, sp = (1 + 5 * r()) * Math.sqrt(s);
      const gr = 0.1 + 0.1 * r();
      fx.smoke(x + (r() - 0.5) * s * 2, y + r() * s * 2, z + (r() - 0.5) * s * 2, Math.cos(a) * sp, 2 + 5 * r() * Math.sqrt(s), Math.sin(a) * sp, (4 + 5 * r()) * (0.6 + 0.4 * s), 2 * s, (7 + 6 * r()) * s, gr, gr * 0.95, gr * 0.9, 0.72, 0.7, 2.2);
    }
    // Dust kicked out along the ground.
    if (y - g < 8 * s) {
      const c = 0.45 + 0.1 * r();
      const n = Math.round(12 * s);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + r() * 0.3, sp = (14 + 14 * r()) * Math.sqrt(s);
        fx.smoke(x, Math.max(g, 0) + 0.6, z, Math.cos(a) * sp, 1 + r() * 2, Math.sin(a) * sp, 2 + r() * 2, 1.5 * s, (6 + 4 * r()) * s, c, c * 0.9, c * 0.75, 0.5, 1.4, 0.3);
      }
    }
    if (s >= 0.85) this.addBurst(false, x, y, z, 0.2 * s, 5.5 * s, 0.38, 0.95);
    this.flashLight(x, y, z, 9000 * s * s);
    this.shake(x, y, z, 0.6 * s);
  }

  private flashLight(x: number, y: number, z: number, intensity: number): void {
    if (intensity < this.light.intensity * 0.6) return;
    const o = this.engine.origin;
    this.light.position.set(x - o.x, y + 4, z - o.z);
    this.light.intensity = intensity;
  }

  private throwDebris(x: number, y: number, z: number, n: number, s: number): void {
    const r = this.rnd;
    for (let i = 0; i < n; i++) {
      if (this.debris.length >= MAX_DEBRIS) this.debris.shift();
      const a = r() * Math.PI * 2, sp = (8 + 22 * r()) * Math.sqrt(s);
      this.debris.push({
        x, y, z, vx: Math.cos(a) * sp, vy: 10 + r() * 28 * Math.sqrt(s), vz: Math.sin(a) * sp,
        ax: r() * 6, ay: r() * 6, az: r() * 6, spin: 4 + r() * 10,
        size: 0.25 + r() * r() * 1.6 * s, age: 0, life: 9 + r() * 8, burning: r() < 0.2, resting: false,
      });
    }
  }

  /** The compound goes up: a fireball, a shock wave, debris, secondaries all through it, then fire and a column of smoke. */
  private megaExplosion(c: CompoundState): void {
    const s = c.site, r = this.rnd;
    const x = s.x, y = s.y + 6, z = s.z;
    this.explode(x, y, z, 3.4);
    // A fireball that swells, holds, and climbs; a white flash of compressed air round it; the ground shock.
    this.addBurst(false, x, y + 10, z, 10, 85, 3.2, 1, new THREE.Color(1, 0.48, 0.12), 1, 0.35, 9);
    this.addBurst(false, x, y + 14, z, 6, 55, 2.4, 0.9, new THREE.Color(1, 0.72, 0.3), 1, 0.4, 12);
    this.addBurst(false, x, y + 6, z, 4, 150, 0.6, 0.4, new THREE.Color(1, 0.98, 0.92), 0);
    this.addBurst(true, x, Math.max(0, this.ground(x, z)) + 1.5, z, 5, 420, 2.0, 1);
    {
      const fx = this.fx;
      for (let i = 0; i < 240; i++) {
        const a = r() * Math.PI * 2, e = Math.asin(r() * 1.6 - 0.6), sp = 8 + 34 * r();
        fx.glow(x + (r() - 0.5) * 30, y + r() * 20, z + (r() - 0.5) * 30, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 6, Math.sin(a) * Math.cos(e) * sp, 1.4 + r() * 2, 18 + r() * 14, 45 + r() * 35, 1, 0.36 + r() * 0.3, 0.07, 0.85, 1.1, 7);
      }
      for (let i = 0; i < 120; i++) {
        const a = r() * Math.PI * 2, sp = 6 + 20 * r();
        const gr = 0.06 + 0.08 * r();
        fx.smoke(x + (r() - 0.5) * 40, y + r() * 25, z + (r() - 0.5) * 40, Math.cos(a) * sp, 4 + r() * 18, Math.sin(a) * sp, 14 + r() * 12, 20, 60 + r() * 40, gr, gr * 0.95, gr * 0.9, 0.8, 0.45, 2.6);
      }
    }
    this.throwDebris(x, y, z, 110, 2.6);
    this.flashLight(x, y + 20, z, 6e5);
    const d = Math.hypot(x - this.cam.x, y - this.cam.y, z - this.cam.z);
    this.screenFlash = Math.max(this.screenFlash, Math.min(0.45, 300 / (d + 300)));
    this.kick = Math.max(this.kick, Math.min(3, 900 / (d + 150)));
    // Secondaries ripple through the buildings.
    c.parts.forEach((p, i) => {
      this.timeline.push({ t: this.time + 0.15 + i * 0.14 + r() * 0.5, fn: () => {
        this.explode(p.cx, p.cy + 1, p.cz, 1.1 + r() * 1.2);
        this.throwDebris(p.cx, p.cy + 1, p.cz, 6, 1);
      } });
    });
    // The fireball climbs and the smoke mushrooms out over it.
    for (let k = 0; k < 6; k++) {
      this.timeline.push({ t: this.time + 0.35 + k * 0.22, fn: () => {
        const fx = this.fx;
        const h = 20 + k * 22;
        for (let i = 0; i < 40; i++) {
          const a = r() * Math.PI * 2, sp = 4 + r() * (k > 3 ? 22 : 10);
          fx.glow(x + Math.cos(a) * 10, y + h, z + Math.sin(a) * 10, Math.cos(a) * sp, 24 + r() * 14, Math.sin(a) * sp, 1.3 + r() * 1.2, 16, 40 + r() * 25, 1, 0.4 + r() * 0.25, 0.08, 0.85, 1.2, 6);
        }
        for (let i = 0; i < 24; i++) {
          const a = r() * Math.PI * 2, sp = 3 + r() * (k > 3 ? 26 : 8);
          const gr = 0.06 + 0.06 * r();
          fx.smoke(x + Math.cos(a) * 12, y + h, z + Math.sin(a) * 12, Math.cos(a) * sp, 20 + r() * 18, Math.sin(a) * sp, 20 + r() * 12, 20, 70 + r() * 40, gr, gr * 0.95, gr * 0.9, 0.8, 0.3, 3.4);
        }
      } });
    }
    for (const [t, sz] of [[0.9, 2.8], [1.7, 2.4], [2.6, 2.0], [3.8, 1.6]]) {
      this.timeline.push({ t: this.time + t, fn: () => {
        const ex = x + (r() - 0.5) * s.half, ez = z + (r() - 0.5) * s.half;
        this.explode(ex, y + 3, ez, sz);
        this.flashLight(ex, y + 10, ez, 1.5e5 * sz);
      } });
    }
    for (const p of c.parts) {
      this.fires.push({ x: p.cx, y: p.cy + p.type.hy * 0.6, z: p.cz, until: this.time + 60 + r() * 60, rate: 9, size: 1 + r() * 0.8, acc: 0, column: false });
    }
  }

  private runTimeline(dt: number): void {
    if (!this.timeline.length || dt <= 0) return;
    const due = this.timeline.filter((e) => e.t <= this.time);
    if (!due.length) return;
    this.timeline = this.timeline.filter((e) => e.t > this.time);
    for (const e of due) e.fn();
  }

  private addBurst(ring: boolean, x: number, y: number, z: number, r0: number, r1: number, life: number, alpha: number, color = new THREE.Color(1, 0.5, 0.16), hot = 1, hold = 0, rise = 0): void {
    let b = this.bursts.find((q) => q.age >= q.life && q.ring === ring);
    if (!b) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uT: { value: 0 }, uAlpha: { value: 0 }, uHot: { value: 1 }, uCol: { value: new THREE.Color() } },
        vertexShader: FIREBALL_VERT,
        fragmentShader: ring ? RING_FRAG : FIREBALL_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: ring ? THREE.DoubleSide : THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(ring ? this.burstRing : this.burstSphere, mat);
      if (ring) mesh.rotation.x = -Math.PI / 2;
      mesh.frustumCulled = false;
      mesh.renderOrder = 31;
      this.engine.scene.add(mesh);
      b = { mesh, mat, ring, x: 0, y: 0, z: 0, age: 0, life: 0, r0: 0, r1: 0, alpha: 0, hold: 0, rise: 0 };
      this.bursts.push(b);
    }
    b.x = x; b.y = y; b.z = z;
    b.age = 0;
    b.life = life;
    b.r0 = r0;
    b.r1 = r1;
    b.alpha = alpha;
    b.hold = hold;
    b.rise = rise;
    if (ring) b.mat.uniforms.uCol.value.setRGB(1, 0.86, 0.66);
    else b.mat.uniforms.uCol.value.copy(color);
    b.mat.uniforms.uHot.value = hot;
    b.mesh.visible = true;
  }

  private updateBursts(dt: number): void {
    const o = this.engine.origin;
    for (const b of this.bursts) {
      if (b.age >= b.life) {
        b.mesh.visible = false;
        continue;
      }
      b.age += dt;
      const t = Math.min(1, b.age / b.life);
      // Fast out, easing to a stop, fading as it grows.
      const grow = 1 - Math.pow(1 - t, 3);
      b.mesh.scale.setScalar(b.r0 + (b.r1 - b.r0) * grow);
      b.mesh.position.set(b.x - o.x, b.y + b.rise * b.age, b.z - o.z);
      b.mat.uniforms.uT.value = this.time;
      const fade = t < b.hold ? 1 : Math.pow(1 - (t - b.hold) / (1 - b.hold), 2);
      b.mat.uniforms.uAlpha.value = b.alpha * fade * Math.min(1, t * 12);
    }
  }

  private updateDebris(dt: number): void {
    const list = this.debris, o = this.engine.origin;
    if (!list.length) {
      this.debrisMesh.count = 0;
      return;
    }
    let n = 0;
    for (const d of list) {
      d.age += dt;
      if (d.age >= d.life) continue;
      if (!d.resting) {
        d.vy -= 9.81 * dt;
        const k = Math.exp(-0.15 * dt);
        d.vx *= k;
        d.vz *= k;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        d.z += d.vz * dt;
        d.ax += d.spin * dt;
        d.ay += d.spin * 0.7 * dt;
        const g = Math.max(0, this.ground(d.x, d.z)) + d.size * 0.3;
        if (d.y < g) {
          d.y = g;
          if (d.vy < -4) {
            d.vy *= -0.3;
            d.vx *= 0.5;
            d.vz *= 0.5;
            d.spin *= 0.5;
          } else d.resting = true;
        }
        // A few burning pieces trail smoke, at a fixed rate so they never crowd out the blast itself.
        if (d.burning && d.age < 3.5 && dt > 0 && this.rnd() < 9 * dt) {
          this.fx.smoke(d.x, d.y, d.z, 0, 1, 0, 1.6 + this.rnd(), 0.4 * d.size + 0.4, 2.6 * d.size + 1.5, 0.1, 0.1, 0.09, 0.6, 0.8, 1);
          this.fx.glow(d.x, d.y, d.z, 0, 0, 0, 0.08, 0.9 * d.size + 0.4, 0.3, 1, 0.5, 0.15, 0.9, 0);
        }
      }
      const shrink = Math.min(1, (d.life - d.age) / 1.5);
      this.v3.set(d.x - o.x, d.y, d.z - o.z);
      this.q4.setFromEuler(this.e3.set(d.ax, d.ay, d.az));
      this.s3.set(d.size * 1.6, d.size * 0.5, d.size).multiplyScalar(shrink);
      this.m4.compose(this.v3, this.q4, this.s3);
      this.debrisMesh.setMatrixAt(n, this.m4);
      list[n++] = d;
    }
    list.length = n;
    this.debrisMesh.count = n;
    this.debrisMesh.instanceMatrix.needsUpdate = true;
  }

  private updateFires(dt: number): void {
    if (dt <= 0) return;
    const fx = this.fx, r = this.rnd;
    let n = 0;
    for (const f of this.fires) {
      if (this.time > f.until) continue;
      this.fires[n++] = f;
      const d = Math.hypot(f.x - this.cam.x, f.z - this.cam.z);
      if (d > (f.column ? 9000 : 4000)) continue;
      // Fires die down toward the end.
      const left = Math.min(1, (f.until - this.time) / 20);
      f.acc += f.rate * left * dt;
      while (f.acc >= 1) {
        f.acc -= 1;
        if (f.column) {
          const gr = 0.06 + 0.05 * r();
          fx.smoke(f.x + (r() - 0.5) * 24, f.y, f.z + (r() - 0.5) * 24, (r() - 0.5) * 2, 9 + r() * 6, (r() - 0.5) * 2, 22 + r() * 12, 10 * f.size, 48 * f.size, gr, gr * 0.96, gr * 0.92, 0.6, 0.2, 2.4);
          continue;
        }
        fx.glow(f.x + (r() - 0.5) * 3 * f.size, f.y, f.z + (r() - 0.5) * 3 * f.size, (r() - 0.5) * 1.5, 3 + r() * 3, (r() - 0.5) * 1.5, 0.45 + r() * 0.4, 2.2 * f.size, 0.6 * f.size, 1, 0.42 + r() * 0.25, 0.1, 0.8, 1.6, 4);
        if (r() < 0.45) {
          const gr = 0.08 + 0.06 * r();
          fx.smoke(f.x, f.y + 2, f.z, (r() - 0.5) * 1.5, 3 + r() * 2, (r() - 0.5) * 1.5, 7 + r() * 5, 2 * f.size, 13 * f.size, gr, gr * 0.96, gr * 0.92, 0.6, 0.35, 1.6);
        }
      }
    }
    this.fires.length = n;
  }
}
