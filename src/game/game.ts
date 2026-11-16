import * as THREE from 'three';
import { AIRCRAFT, type AircraftData } from '../data/aircraft';
import type { Action } from '../data/controls';
import type { QualityName } from '../data/graphics';
import { CameraRig } from '../render/cameras';
import { Engine } from '../render/engine';
import { buildHeliModel, type HeliModel } from '../render/heliModel';
import { PropSystem } from '../render/propSystem';
import { Sky } from '../render/sky';
import { TerrainSystem } from '../render/terrainSystem';
import { Water } from '../render/water';
import type { Bindings } from '../sim/controls';
import { KTS, Quat, RAD, Vec3 } from '../sim/math';
import { FIXED_DT, Simulation } from '../sim/simulation';
import { seedToString } from '../world/rng';
import { helipadsNear, type Helipad } from '../world/structures';
import { WorkerPool } from '../world/workerPool';
import { World } from '../world/world';
import { KeyboardInput } from './input';
import { WorldEnvironment } from './worldEnv';

export interface GameOptions {
  canvas: HTMLCanvasElement;
  hud: HTMLElement;
  seed: number;
  quality: QualityName;
  aircraft?: string;
  bindings?: Bindings;
}

export interface SpawnPoint {
  x: number;
  z: number;
  heading: number;
  /** Surface height to stand on (a helipad or roof). Defaults to the ground. */
  y?: number;
  name?: string;
}

export interface SpawnLoad {
  fuelFraction?: number;
  payload?: number;
}

export type GameMode = 'menu' | 'fly';

const NAV_COLORS = [0xff2a1a, 0x1aff4a, 0xffffff];

/** Top-level orchestration: owns the world, the simulation and the renderer, and runs the frame loop. */
export class Game {
  readonly engine: Engine;
  readonly world: World;
  readonly env: WorldEnvironment;
  readonly pool: WorkerPool;
  readonly terrain: TerrainSystem;
  readonly water: Water;
  readonly props: PropSystem;
  readonly sky: Sky;
  readonly rig: CameraRig;
  readonly input = new KeyboardInput();
  sim!: Simulation;
  model!: HeliModel;
  aircraft: AircraftData;
  bindings: Bindings | undefined;

  mode: GameMode = 'fly';
  /** True once the world around the aircraft has finished streaming in. */
  ready = false;
  paused = false;
  frames = 0;
  /** Smoothed frame time, ms. */
  frameMs = 16.7;
  /** Seconds flown since the last spawn. */
  flightTime = 0;
  /** Where the aircraft last stood on a helipad (or spawned), for respawning. */
  lastPad: SpawnPoint;
  lastLoad: SpawnLoad = {};
  landingLightOn = false;

  /** Hooks for the UI and audio layers. */
  onFrame: ((dt: number) => void) | null = null;
  onAction: ((action: Action) => void) | null = null;
  onSpawn: (() => void) | null = null;

  private last = 0;
  private raf = 0;
  private hud: HTMLElement;
  readonly renderPos = new Vec3();
  readonly renderQ = new Quat();
  private readonly focus = new THREE.Vector3();
  private padTimer = 0;

  constructor(opts: GameOptions) {
    this.hud = opts.hud;
    this.bindings = opts.bindings;
    this.engine = new Engine(opts.canvas, opts.quality);
    this.world = new World(opts.seed);
    this.env = new WorldEnvironment(this.world);
    this.pool = new WorkerPool(opts.seed, Math.max(1, Math.min(this.engine.quality.workers, (navigator.hardwareConcurrency || 4) - 1)));
    this.sky = new Sky(this.engine);
    this.terrain = new TerrainSystem(this.engine, this.pool);
    this.water = new Water(this.engine, this.sky);
    this.props = new PropSystem(this.engine, this.pool, {
      onStructures: (key, cell) => this.env.colliders.add(key, cell.x0, cell.z0, cell.colliders),
      onRemove: (key) => this.env.colliders.remove(key),
    });
    this.rig = new CameraRig(this.engine, (x, z) => this.env.ground(x, z));
    this.aircraft = AIRCRAFT[opts.aircraft ?? 'medium'] ?? AIRCRAFT.medium;
    this.lastPad = this.findSpawn();
    this.spawn(this.aircraft, this.lastPad);
    window.addEventListener('resize', () => this.engine.resize());
  }

  /** Helipads within `range` of a point, nearest first. */
  helipads(x: number, z: number, range = 30000): Helipad[] {
    return helipadsNear(this.world, x, z, range);
  }

  /** Default start: the nearest city heliport to the world origin, else the nearest helipad, else open ground. */
  findSpawn(): SpawnPoint {
    const pads = this.helipads(0, 0);
    const pad = pads.find((p) => p.kind === 'ground' && p.rank === 3) ?? pads.find((p) => p.kind === 'ground') ?? pads[0];
    if (pad) return { x: pad.x, z: pad.z, y: pad.y, heading: pad.heading, name: pad.name };
    for (let ring = 0; ring < 400; ring++) {
      const r = ring * 180;
      const n = Math.max(1, Math.floor(ring * 1.5));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + ring * 0.7;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const h = this.world.height(x, z);
        if (h > 4 && h < 300 && Math.abs(this.world.height(x + 12, z) - h) < 0.5 && Math.abs(this.world.height(x, z + 12) - h) < 0.5) return { x, z, heading: 0 };
      }
    }
    return { x: 0, z: 0, heading: 0 };
  }

  /** Put an aircraft on the surface at a spawn point, or in the air at `altitude` above it. */
  spawn(data: AircraftData, at: SpawnPoint, altitude = 0, speed = 0, load: SpawnLoad = this.lastLoad): void {
    if (this.model) {
      this.engine.scene.remove(this.model.root);
      this.model.dispose();
    }
    this.aircraft = data;
    this.lastLoad = load;
    const ground = at.y ?? Math.max(0, this.env.ground(at.x, at.z));
    // Hold the simulation until the buildings and pads around the new position have streamed in.
    this.ready = false;
    this.sim = new Simulation(
      data,
      this.env,
      altitude > 0
        ? { x: at.x, y: ground + altitude, z: at.z, heading: at.heading, airborne: true, speed, ...load }
        : { x: at.x, y: ground, z: at.z, heading: at.heading, ...load },
      this.bindings,
      this.world.seed,
    );
    this.input.attach(this.sim, () => this.sim.actions.releaseAll());
    this.model = buildHeliModel(data);
    this.engine.scene.add(this.model.root);
    this.rig.reset();
    this.flightTime = 0;
    this.padTimer = 0;
    if (altitude === 0) this.lastPad = at;
    this.onSpawn?.();
  }

  /** Back to the last helipad the aircraft stood on, in a fresh aircraft. */
  respawn(): void {
    this.spawn(this.aircraft, this.lastPad);
  }

  setBindings(b: Bindings): void {
    this.bindings = b;
    this.sim.actions.setBindings(b);
  }

  setMode(mode: GameMode): void {
    this.mode = mode;
    this.rig.mode = mode === 'menu' ? 'orbit' : 'chase';
    this.rig.reset();
    if (mode === 'menu') this.sim.actions.releaseAll();
  }

  start(): void {
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  /** One rendered frame: step the sim, move the camera, refresh the world, draw. */
  frame(dt: number): void {
    const h = this.sim.heli;
    const live = !this.paused && this.ready && this.mode === 'fly';
    if (live) {
      this.env.setAgl(h.tel.radarAlt);
      this.sim.advance(dt);
      this.flightTime += dt;
      for (const a of this.sim.takeGameActions()) this.handleAction(a);
      this.trackPad(dt);
    } else {
      // Keys pressed while paused or in the menu still reach the shell (pause, controls…).
      for (const a of this.sim.actions.takePressed()) this.handleAction(a);
    }
    this.frames++;
    this.frameMs += (dt * 1000 - this.frameMs) * 0.05;
    if (!this.paused) this.engine.timeUniform.value += dt;

    // Aircraft pose for this frame: the sim state, wound back by the unsimulated remainder.
    const back = live ? (1 - this.sim.alpha) * FIXED_DT : 0;
    this.renderPos.copy(h.pos).addScaled(h.vel, -back);
    this.renderQ.copy(h.q).integrateBody(-h.omega.x, -h.omega.y, -h.omega.z, back);

    const e = this.engine, m = this.model;
    e.updateOrigin(this.renderPos.x, this.renderPos.z);
    e.toScene(this.renderPos.x, this.renderPos.y, this.renderPos.z, m.root.position);
    m.root.quaternion.set(this.renderQ.x, this.renderQ.y, this.renderQ.z, this.renderQ.w);
    this.animateModel(dt);
    this.rig.update(dt, this.renderPos, this.renderQ, h.att.heading, this.aircraft.rotor.diameter / 2, m.eye, live ? h.tel.vibration : 0, e.timeUniform.value);
    const cockpit = this.rig.mode === 'cockpit';
    m.shell.visible = !cockpit;
    m.cockpit.visible = cockpit;

    const w = this.rig.world;
    this.terrain.update(w.x, w.y, w.z);
    const night = 1 - THREE.MathUtils.smoothstep(this.sky.daylight, 0.12, 0.5);
    this.props.update(w.x, w.y, w.z, night, this.sky.fog.density);
    if (!this.ready && this.terrain.settled && this.props.settled && this.terrain.stats.generated > 0) this.ready = true;
    this.focus.copy(m.root.position);
    this.sky.update(this.focus);
    this.water.update(this.sky.daylight);
    this.onFrame?.(dt);
    e.render();
    if (this.frames % 6 === 0 && this.hud.classList.contains('on')) this.drawDebug();
  }

  private animateModel(dt: number): void {
    const h = this.sim.heli, m = this.model;
    const n = h.rotorN;
    m.blades.rotation.y = h.rotorAngle;
    m.tailBlades.rotation.x = h.rotorAngle * 4.7;
    const blur = THREE.MathUtils.smoothstep(n, 0.3, 0.8);
    (m.rotorBlur.material as THREE.MeshBasicMaterial).opacity = (h.rotorOk ? 0.17 : 0) * blur;
    (m.tailBlur.material as THREE.MeshBasicMaterial).opacity = (h.tailRotorOk ? 0.2 : 0) * blur;
    m.blades.visible = n < 0.9 && h.rotorOk;
    m.tailBlades.visible = n < 0.9 && h.tailRotorOk;
    // Lights: steady nav lights and a flashing beacon whenever the aircraft has power.
    const powered = h.engine !== 'off' || n > 0.05;
    const t = this.engine.timeUniform.value;
    const level = powered ? 0.7 + 1.6 * (1 - this.sky.daylight) : 0.05;
    m.navLights.forEach((l, i) => l.color.setHex(NAV_COLORS[i]).multiplyScalar(level));
    m.beacon.color.setHex(0xff2010).multiplyScalar(powered && t % 1.1 < 0.12 ? 4 : 0.05);
    m.landingLight.intensity += ((this.landingLightOn && powered ? 900 : 0) - m.landingLight.intensity) * Math.min(1, dt * 8);
  }

  /** Remember the helipad the aircraft is resting on, for respawning. */
  private trackPad(dt: number): void {
    const h = this.sim.heli;
    if (h.tel.onGround && h.tel.surfaceKind === 3 && h.vel.len() < 0.3 && !h.destroyed) {
      this.padTimer += dt;
      if (this.padTimer > 1.5) {
        this.lastPad = { x: h.pos.x, z: h.pos.z, y: h.pos.y - h.ac.restHeight, heading: h.att.heading, name: 'Last helipad' };
        this.padTimer = -1e9; // once per landing
      }
    } else if (!h.tel.onGround) this.padTimer = 0;
  }

  private handleAction(a: Action): void {
    if (a === 'cameraNext' && this.mode === 'fly') this.rig.next();
    else if (a === 'landingLight') this.landingLightOn = !this.landingLightOn;
    else if (a === 'respawn' && this.mode === 'fly') this.respawn();
    this.onAction?.(a);
  }

  private drawDebug(): void {
    const t = this.sim.heli.tel, h = this.sim.heli, r = this.engine.renderer.info.render;
    this.hud.textContent = [
      `SEED ${seedToString(this.world.seed)}  ${this.ready ? '' : 'GENERATING…'}`,
      `${this.aircraft.name}  ENG ${h.engine}  NR ${(t.rotorRpm * 100).toFixed(0)}%  TQ ${(t.torque * 100).toFixed(0)}%  mass ${t.mass.toFixed(0)}`,
      `IAS ${(t.airspeed / KTS).toFixed(0)} kt  ALT ${t.baroAlt.toFixed(0)}  RAD ${t.radarAlt.toFixed(1)}  VS ${t.verticalSpeed.toFixed(1)}  HDG ${(t.heading * RAD).toFixed(0)}`,
      `${(1000 / this.frameMs).toFixed(0)} fps  nodes ${this.terrain.stats.shown}  tris ${(r.triangles / 1000).toFixed(0)}k  calls ${r.calls}  cells ${this.props.stats.structureCells}/${this.props.stats.forestCells}`,
    ].join('\n');
  }

  /** Points of interest near the aircraft, for tests and screenshots. */
  debugTargets(): { city?: { x: number; z: number; r: number }; town?: { x: number; z: number; r: number }; bridge?: { x: number; z: number; y: number; heading: number; span: number } } {
    const p = this.sim.heli.pos;
    const near = this.world.settlements.within(p.x, p.z, 40000).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    const pick = (kind: number) => {
      const s = near.find((q) => q.kind === kind);
      return s ? { x: s.x, z: s.z, r: s.radius } : undefined;
    };
    let bridge: { x: number; z: number; y: number; heading: number; span: number } | undefined;
    for (const road of this.world.roads.inRect(p.x - 20000, p.z - 20000, p.x + 20000, p.z + 20000)) {
      for (const [a, b] of road.bridges) {
        const span = road.points[b].s - road.points[a].s;
        if (!bridge || span > bridge.span) {
          const m = road.points[Math.floor((a + b) / 2)];
          bridge = { x: m.x, z: m.z, y: m.y, heading: (Math.atan2(-m.nz, m.nx) * 180) / Math.PI, span };
        }
      }
    }
    return { city: pick(3), town: pick(2), bridge };
  }

  /** Teleport for tests and screenshots: hover at a world position and altitude above ground. */
  setPose(x: number, z: number, altitude: number, headingDeg = 0, speed = 0): void {
    this.spawn(this.aircraft, { x, z, heading: headingDeg / RAD }, altitude, speed);
  }
}
