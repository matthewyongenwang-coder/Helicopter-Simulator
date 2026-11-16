import * as THREE from 'three';
import { AIRCRAFT, type AircraftData } from '../data/aircraft';
import type { QualityName } from '../data/graphics';
import { Engine } from '../render/engine';
import { buildHeliModel, type HeliModel } from '../render/heliModel';
import { PropSystem } from '../render/propSystem';
import { Sky } from '../render/sky';
import { TerrainSystem } from '../render/terrainSystem';
import { Water } from '../render/water';
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
}

export interface SpawnPoint {
  x: number;
  z: number;
  heading: number;
  /** Surface height to stand on (a helipad or roof). Defaults to the ground. */
  y?: number;
  name?: string;
}

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
  readonly input = new KeyboardInput();
  sim!: Simulation;
  model!: HeliModel;
  aircraft: AircraftData;

  /** True once the first terrain has finished generating. */
  ready = false;
  paused = false;
  frames = 0;
  /** Smoothed frame time, ms. */
  frameMs = 16.7;

  private last = 0;
  private raf = 0;
  private hud: HTMLElement;
  private readonly camWorld = new Vec3();
  private readonly renderPos = new Vec3();
  private readonly renderQ = new Quat();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpV = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private camInit = false;

  constructor(private opts: GameOptions) {
    this.hud = opts.hud;
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
    this.aircraft = AIRCRAFT[opts.aircraft ?? 'medium'] ?? AIRCRAFT.medium;
    this.spawn(this.aircraft, this.findSpawn());
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
        if (h < 4 || h > 300) continue;
        const slope = Math.max(
          Math.abs(this.world.height(x + 12, z) - h),
          Math.abs(this.world.height(x - 12, z) - h),
          Math.abs(this.world.height(x, z + 12) - h),
          Math.abs(this.world.height(x, z - 12) - h),
        );
        if (slope < 0.5) return { x, z, heading: 0 };
      }
    }
    return { x: 0, z: 0, heading: 0 };
  }

  /** Put an aircraft on the ground at a spawn point (or in the air at `altitude` above it). */
  spawn(data: AircraftData, at: SpawnPoint, altitude = 0, speed = 0): void {
    if (this.model) {
      this.engine.scene.remove(this.model.root);
      this.model.dispose();
    }
    this.aircraft = data;
    const ground = at.y ?? Math.max(0, this.env.ground(at.x, at.z));
    // Hold the simulation until the buildings and pads around the new position have streamed in.
    this.ready = false;
    this.sim = new Simulation(
      data,
      this.env,
      altitude > 0
        ? { x: at.x, y: ground + altitude, z: at.z, heading: at.heading, airborne: true, speed }
        : { x: at.x, y: ground, z: at.z, heading: at.heading },
      undefined,
      this.world.seed,
    );
    this.input.attach(this.sim, () => this.sim.actions.releaseAll());
    this.model = buildHeliModel(data);
    this.engine.scene.add(this.model.root);
    this.camInit = false;
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
    if (!this.paused && this.ready) {
      this.env.setAgl(h.tel.radarAlt);
      this.sim.advance(dt);
      this.sim.takeGameActions();
    }
    this.frames++;
    this.frameMs += (dt * 1000 - this.frameMs) * 0.05;
    this.engine.timeUniform.value += dt;

    // Aircraft pose for this frame: the sim state, wound back by the unsimulated remainder.
    const back = this.paused ? 0 : (1 - this.sim.alpha) * FIXED_DT;
    this.renderPos.copy(h.pos).addScaled(h.vel, -back);
    this.renderQ.copy(h.q).integrateBody(-h.omega.x, -h.omega.y, -h.omega.z, back);

    this.updateCamera(dt);
    this.engine.updateOrigin(this.camWorld.x, this.camWorld.z);

    const e = this.engine;
    e.toScene(this.renderPos.x, this.renderPos.y, this.renderPos.z, this.model.root.position);
    this.model.root.quaternion.set(this.renderQ.x, this.renderQ.y, this.renderQ.z, this.renderQ.w);
    this.model.blades.rotation.y = h.rotorAngle;
    this.model.tailRotor.rotation.x = h.rotorAngle * 4.7;
    const n = h.rotorN;
    (this.model.rotorBlur.material as THREE.MeshBasicMaterial).opacity = 0.16 * THREE.MathUtils.smoothstep(n, 0.25, 0.75);
    this.model.blades.visible = n < 0.85;
    e.toScene(this.camWorld.x, this.camWorld.y, this.camWorld.z, e.camera.position);
    this.focus.copy(this.model.root.position);
    e.camera.lookAt(this.focus.x, this.focus.y + 1.2, this.focus.z);

    this.terrain.update(this.camWorld.x, this.camWorld.y, this.camWorld.z);
    const night = 1 - THREE.MathUtils.smoothstep(this.sky.daylight, 0.12, 0.5);
    this.props.update(this.camWorld.x, this.camWorld.y, this.camWorld.z, night, this.sky.fog.density);
    if (!this.ready && this.terrain.settled && this.props.settled && this.terrain.stats.generated > 0) this.ready = true;
    this.sky.update(this.focus);
    this.water.update(this.sky.daylight);
    e.render();
    if (this.frames % 6 === 0) this.drawHud();
  }

  private updateCamera(dt: number): void {
    const h = this.sim.heli;
    const R = this.aircraft.rotor.diameter / 2;
    const dist = 9 + R * 1.7, height = 3 + R * 0.45;
    // Behind the aircraft along its heading, ignoring pitch and roll.
    const hd = h.att.heading;
    const tx = this.renderPos.x - Math.sin(hd) * dist;
    const tz = this.renderPos.z + Math.cos(hd) * dist;
    let ty = this.renderPos.y + height;
    const floor = Math.max(0, this.env.ground(tx, tz)) + 1.5;
    if (ty < floor) ty = floor;
    if (!this.camInit) {
      this.camWorld.set(tx, ty, tz);
      this.camInit = true;
      return;
    }
    const k = 1 - Math.exp(-dt * 6);
    this.camWorld.x += (tx - this.camWorld.x) * k;
    this.camWorld.y += (ty - this.camWorld.y) * k;
    this.camWorld.z += (tz - this.camWorld.z) * k;
  }

  private drawHud(): void {
    const t = this.sim.heli.tel, h = this.sim.heli;
    const lines = [
      `SEED ${seedToString(this.world.seed)}`,
      this.ready ? '' : 'GENERATING WORLD…',
      `${this.aircraft.name}  ENG ${h.engine.toUpperCase()}  NR ${(t.rotorRpm * 100).toFixed(0)}%  TQ ${(t.torque * 100).toFixed(0)}%`,
      `IAS ${(t.airspeed / KTS).toFixed(0)} kt  ALT ${t.baroAlt.toFixed(0)} m  RAD ${t.radarAlt.toFixed(0)} m  VS ${t.verticalSpeed.toFixed(1)} m/s`,
      `HDG ${(t.heading * RAD).toFixed(0)}°  COLL ${(t.collective * 100).toFixed(0)}%  ${h.autohover.engaged ? 'AUTOHOVER ' + h.autohover.mode.toUpperCase() : ''}`,
      `${(1000 / this.frameMs).toFixed(0)} fps  nodes ${this.terrain.stats.shown}  tris ${(this.engine.renderer.info.render.triangles / 1000).toFixed(0)}k  calls ${this.engine.renderer.info.render.calls}`,
      h.destroyed ? `DESTROYED: ${h.destroyedReason}` : '',
    ];
    this.hud.textContent = lines.filter(Boolean).join('\n');
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
