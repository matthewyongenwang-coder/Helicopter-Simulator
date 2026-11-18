import * as THREE from 'three';
import { AIRCRAFT, type AircraftData } from '../data/aircraft';
import type { Action } from '../data/controls';
import type { QualityName } from '../data/graphics';
import { AIRCRAFT_VISUAL } from '../data/aircraftVisual';
import { CameraRig } from '../render/cameras';
import { CombatView } from '../render/combatView';
import { SupplyView } from '../render/supplyView';
import { Clouds } from '../render/clouds';
import { Effects } from '../render/effects';
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
import { Combat, type CombatEvent, type CombatInput, type PlayerState } from './combat';
import { KeyboardInput } from './input';
import { Resupply, type SupplyEvent } from './resupply';
import { WeatherSystem } from './weather';
import { WorldEnvironment } from './worldEnv';

export interface GameOptions {
  canvas: HTMLCanvasElement;
  hud: HTMLElement;
  seed: number;
  quality: QualityName;
  aircraft?: string;
  bindings?: Bindings;
  weather?: string;
  /** Start hour, or −1 for the default. */
  hour?: number;
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

/** Where the reticle sits on screen (normalised device y), per camera: above the aircraft in the chase view. */
export const AIM_NDC_Y = { chase: 0.3, cockpit: 0, orbit: 0 } as const;

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
  readonly clouds: Clouds;
  readonly effects: Effects;
  readonly weather: WeatherSystem;
  readonly input = new KeyboardInput();
  readonly combat: Combat;
  readonly combatView: CombatView;
  /** Combat events from this frame, for the HUD and audio. */
  combatEvents: CombatEvent[] = [];
  /** Supply points and the ground crew; events from this frame. */
  readonly supply: Resupply;
  readonly supplyView: SupplyView;
  supplyEvents: SupplyEvent[] = [];
  /** Mouse trigger (left button held), and one-shot missile and flare requests. */
  gunHeld = false;
  private missileQueued = false;
  private flaresQueued = false;
  private readonly player: PlayerState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1, radius: 3, agl: 0, alive: true, fragility: 1 };
  private readonly combatInput: CombatInput = { gun: false, missile: false, flares: false, ray: { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: -1 } };
  private readonly aimV = new THREE.Vector3();
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
  /** Smoothed main-thread time spent in one frame (sim, world streaming, effects, render submit), ms. */
  cpuMs = 0;
  /** Worst main-thread frame time since last read, ms. */
  cpuPeak = 0;
  /** Seconds flown since the last spawn. */
  flightTime = 0;
  /** Where the aircraft last stood on a helipad (or spawned), for respawning. */
  lastPad: SpawnPoint;
  lastLoad: SpawnLoad = {};
  landingLightOn = false;

  /** White-phosphor night-vision goggles. */
  get nightVision(): boolean {
    return this.engine.nightVision.enabled;
  }

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
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly dust = new THREE.Color(0.55, 0.48, 0.36);
  private dustTimer = 0;
  private readonly camPrev = { x: 0, y: 0, z: 0 };
  private readonly camVel = { x: 0, y: 0, z: 0 };
  private discX = 0;
  private discZ = 0;
  private charred = false;
  private castsShadow = true;
  private envScene = new THREE.Scene();
  private pmrem!: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envTimer = 0;
  private cloudDrift = new THREE.Vector2();

  constructor(opts: GameOptions) {
    this.hud = opts.hud;
    this.bindings = opts.bindings;
    this.engine = new Engine(opts.canvas, opts.quality);
    this.world = new World(opts.seed);
    this.env = new WorldEnvironment(this.world);
    this.pool = new WorkerPool(opts.seed, Math.max(1, Math.min(this.engine.quality.workers, (navigator.hardwareConcurrency || 4) - 1)));
    this.sky = new Sky(this.engine);
    this.clouds = new Clouds(this.engine, this.sky);
    this.terrain = new TerrainSystem(this.engine, this.pool, this.clouds.enabled ? this.clouds.uniforms : undefined, this.sky.uniforms.uSunDir);
    this.water = new Water(this.engine, this.sky);
    this.props = new PropSystem(this.engine, this.pool, {
      onStructures: (key, cell) => this.env.colliders.add(key, cell.x0, cell.z0, cell.colliders),
      onRemove: (key) => this.env.colliders.remove(key),
    });
    this.rig = new CameraRig(this.engine, (x, z) => this.env.ground(x, z));
    this.effects = new Effects(this.engine);
    this.combat = new Combat(this.world, { hit: (amount, reason, crit) => this.sim.heli.takeHit(amount, reason, crit) });
    this.combatView = new CombatView(this.engine, this.effects, this.combat, (x, z) => this.combat.surface(x, z, 30));
    this.supply = new Resupply(this.world);
    this.supplyView = new SupplyView(this.engine, this.supply, (x, z) => Math.max(0, this.world.height(x, z)));
    this.weather = new WeatherSystem(opts.seed, opts.weather ?? 'auto', opts.hour ?? -1);
    this.setupLighting();
    this.aircraft = AIRCRAFT[opts.aircraft ?? 'medium'] ?? AIRCRAFT.medium;
    this.lastPad = this.findSpawn();
    this.combat.home = { x: this.lastPad.x, z: this.lastPad.z };
    this.setSupplyHome(this.lastPad);
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
    this.charred = false;
    this.castsShadow = true;
    this.effects.reset();
    this.combat.arm(data.id);
    this.combatView.reset();
    this.supply.reset();
    this.gunHeld = this.missileQueued = this.flaresQueued = false;
    this.rig.reset();
    this.flightTime = 0;
    this.padTimer = 0;
    if (altitude === 0) this.lastPad = at;
    this.onSpawn?.();
  }

  /** The helipad a flight starts from doubles as a supply point. */
  setSupplyHome(at: SpawnPoint): void {
    this.supply.setHome(at.x, at.y ?? Math.max(0, this.env.ground(at.x, at.z)), at.z, at.heading);
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
    const t0 = performance.now();
    this.frameInner(dt);
    const ms = performance.now() - t0;
    this.cpuMs += (ms - this.cpuMs) * 0.05;
    this.cpuPeak = Math.max(this.cpuPeak, ms);
  }

  private frameInner(dt: number): void {
    const h = this.sim.heli;
    const live = !this.paused && this.ready && this.mode === 'fly';
    if (live) {
      this.env.setAgl(h.tel.radarAlt);
      this.sim.advance(dt);
      this.flightTime += dt;
      for (const a of this.sim.takeGameActions()) this.handleAction(a);
      this.trackPad(dt);
      this.supply.update(dt, h, this.combat);
    } else {
      this.supply.update(0, h, this.combat);
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
    this.updateCombat(dt, live);
    this.updateWeather(live ? dt : this.mode === 'menu' ? dt : 0, w.y);
    this.updateEffects(live ? dt : 0, dt);
    this.terrain.update(w.x, w.y, w.z);
    const night = 1 - THREE.MathUtils.smoothstep(this.sky.daylight, 0.12, 0.5);
    this.props.update(w.x, w.y, w.z, night, this.sky.fog.density);
    if (!this.ready && this.terrain.settled && this.props.settled && this.terrain.stats.generated > 0) this.ready = true;
    this.focus.copy(m.root.position);
    this.sky.update(this.focus);
    this.water.update(this.sky.daylight);
    this.updateEnvironmentMap(dt);
    this.onFrame?.(dt);
    e.render(dt, this.sky.daylight);
    if (this.frames % 6 === 0 && this.hud.classList.contains('on')) this.drawDebug();
  }

  private animateModel(dt: number): void {
    const h = this.sim.heli, m = this.model;
    const n = h.rotorN;
    m.blades.rotation.y = h.rotorAngle;
    m.tailBlades.rotation.x = h.rotorAngle * 4.7;
    const blur = THREE.MathUtils.smoothstep(n, 0.3, 0.8);
    (m.rotorBlur.material as THREE.MeshBasicMaterial).opacity = (h.rotorOk ? 0.42 : 0) * blur;
    m.rotorBlur.rotation.z = -h.rotorAngle * 0.03;
    (m.tailBlur.material as THREE.MeshBasicMaterial).opacity = (h.tailRotorOk ? 0.2 : 0) * blur;
    m.blades.visible = n < 0.9 && h.rotorOk;
    m.tailBlades.visible = n < 0.9 && h.tailRotorOk;
    // Blades droop at rest and cone up under load as centrifugal force takes over.
    const spin = THREE.MathUtils.smoothstep(n, 0.15, 0.75);
    const load = h.tel.mass > 0 ? Math.min(1.6, h.tel.thrust / (h.tel.mass * 9.81)) : 0;
    const cone = (0.02 + 0.04 * load) / Math.max(0.6, n * n);
    for (const tilt of m.bladeTilts) tilt.rotation.x = -m.droop * (1 - spin) + Math.min(0.12, cone) * spin;
    // The disc leads the fuselage: it tilts toward the commanded rate before the airframe follows.
    const lead = 0.11 * spin;
    const k = Math.min(1, dt * 14);
    this.discX += (THREE.MathUtils.clamp(h.cmd.wx * lead, -0.12, 0.12) - this.discX) * k;
    this.discZ += (THREE.MathUtils.clamp(h.cmd.wz * lead, -0.12, 0.12) - this.discZ) * k;
    m.rotor.rotation.set(this.discX, 0, this.discZ);
    // The sun's half-degree disc blurs a small aircraft's shadow away a few hundred metres up.
    const casts = h.tel.radarAlt < 350;
    if (casts !== this.castsShadow) {
      this.castsShadow = casts;
      m.root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && o.parent !== m.cockpit) o.castShadow = casts && !(o === m.rotorBlur || o === m.tailBlur);
      });
    }
    if (h.destroyed && !this.charred) {
      this.charred = true;
      for (const mat of m.materials) {
        mat.color.multiplyScalar(0.16);
        mat.roughness = 1;
        mat.metalness = 0;
      }
    }
    // Lights: steady nav lights and a flashing beacon whenever the aircraft has power.
    const powered = h.engine !== 'off' || n > 0.05;
    const t = this.engine.timeUniform.value;
    const level = powered ? 0.7 + 1.6 * (1 - this.sky.daylight) : 0.05;
    m.navLights.forEach((l, i) => l.color.setHex(NAV_COLORS[i]).multiplyScalar(level));
    m.beacon.color.setHex(0xff2010).multiplyScalar(powered && t % 1.1 < 0.12 ? 4 : 0.05);
    m.landingLight.intensity += ((this.landingLightOn && powered ? 900 : 0) - m.landingLight.intensity) * Math.min(1, dt * 8);
  }

  /** Sun shadows around the aircraft, and an environment map of the sky for reflections. */
  private setupLighting(): void {
    const q = this.engine.quality;
    const sun = this.sky.sun;
    sun.castShadow = q.shadows;
    if (q.shadows) {
      sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      const cam = sun.shadow.camera as THREE.OrthographicCamera;
      const r = q.shadowMapSize >= 4096 ? 90 : 70;
      cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
      cam.near = 1;
      cam.far = 1000;
      cam.updateProjectionMatrix();
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.04;
    }
    this.envScene.add(this.sky.envDome());
    this.pmrem = new THREE.PMREMGenerator(this.engine.renderer);
  }

  /** Re-render the sky into the environment map every couple of seconds as the light changes. */
  private updateEnvironmentMap(dt: number): void {
    this.envTimer -= dt;
    if (this.envTimer > 0 && this.envTarget) return;
    this.envTimer = 2;
    const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 100);
    this.envTarget?.dispose();
    this.envTarget = rt;
    this.engine.scene.environment = rt.texture;
    this.engine.scene.environmentIntensity = 0.35 + 0.45 * this.sky.daylight;
  }

  /** Fire a missile on the next frame (mouse or key). */
  fireMissile(): void {
    this.missileQueued = true;
  }

  /** Release a salvo of flares on the next frame. */
  releaseFlares(): void {
    this.flaresQueued = true;
  }

  /** The sight line, the shooting, and everything it sets alight. */
  private updateCombat(dt: number, live: boolean): void {
    const h = this.sim.heli, p = this.player, c = this.combat, w = this.rig.world;
    p.x = this.renderPos.x; p.y = this.renderPos.y; p.z = this.renderPos.z;
    p.vx = h.vel.x; p.vy = h.vel.y; p.vz = h.vel.z;
    p.qx = this.renderQ.x; p.qy = this.renderQ.y; p.qz = this.renderQ.z; p.qw = this.renderQ.w;
    p.radius = Math.max(2.4, this.aircraft.body.length * 0.28);
    p.agl = h.tel.radarAlt;
    p.alive = !h.destroyed;
    p.fragility = this.aircraft.damage.fragility;
    // From the camera through the reticle.
    const cam = this.engine.camera;
    cam.updateMatrixWorld();
    this.aimV.set(0, AIM_NDC_Y[this.rig.mode], 0.5).unproject(cam).sub(cam.position).normalize();
    const ray = this.combatInput.ray!;
    ray.ox = w.x; ray.oy = w.y; ray.oz = w.z;
    ray.dx = this.aimV.x; ray.dy = this.aimV.y; ray.dz = this.aimV.z;
    const inp = this.combatInput;
    inp.gun = live && (this.gunHeld || this.sim.actions.isHeld('fireGun'));
    inp.missile = live && this.missileQueued;
    inp.flares = live && this.flaresQueued;
    this.missileQueued = this.flaresQueued = false;
    if (live) c.update(dt, p, inp, true);
    else if (this.mode === 'menu' && dt > 0) c.update(dt, p, inp, false);
    this.combatEvents = c.takeEvents();
    this.supplyEvents = this.supply.takeEvents();
    this.supplyView.update(this.paused ? 0 : dt, w.x, w.z);
    this.combatView.update(this.paused ? 0 : dt, this.combatEvents, w.x, w.y, w.z);
    if (this.combatView.kick > 0) {
      this.rig.kick(this.combatView.kick);
      this.combatView.kick = 0;
    }
    // Missiles leave their rails as they are fired.
    const m = this.model.missiles;
    const fired = m.length - c.missilesLeft;
    for (let i = 0; i < m.length; i++) m[i].visible = i >= fired;
  }

  /** Clock, weather and wind: drive the sky, clouds, water and the flight model's air. */
  private updateWeather(dt: number, camY: number): void {
    const W = this.weather, h = this.sim.heli, sky = this.sky;
    W.update(dt, this.world, h.pos.x, h.pos.z, h.tel.radarAlt);
    const cur = W.cur;
    this.env.wind_.x = W.windX;
    this.env.wind_.z = W.windZ;
    this.env.wind_.gust = cur.gust;
    this.env.turbulence = W.areaTurbulence;
    const cu = this.clouds.uniforms;
    cu.uCover.value = cur.cover;
    cu.uCloudBase.value = cur.cloudBase;
    cu.uCloudTop.value = cur.cloudBase + 380 + 900 * cur.cover;
    // The cloud field drifts with the wind (faster aloft).
    this.cloudDrift.x -= W.windX * 1.6 * dt;
    this.cloudDrift.y -= W.windZ * 1.6 * dt;
    cu.uCloudWind.value.copy(this.cloudDrift);
    sky.overcast = cur.overcast;
    sky.haze = cur.haze * (1 + 28 * this.clouds.inside(camY));
    sky.setTime(W.hour);
    sky.hemi.intensity += W.flash * 2.2;
    sky.sun.intensity *= 1 - 0.35 * cur.cover * (1 - cur.overcast);
    this.terrain.cloudShadow.value = (1 - cur.overcast) * Math.min(1, cur.cover * 2.5);
    this.clouds.update(sky.daylight, sky.fog.density, cur.lightning > 0 ? cur.precip : 0, W.flash);
    this.water.setWind(W.windX, W.windZ, cur.chop * (0.7 + W.windSpeed / 14));
  }

  /** Downwash, smoke, fire and precipitation, positioned from this frame's pose. */
  private updateEffects(simDt: number, dt: number): void {
    const h = this.sim.heli, t = h.tel, m = this.model, d = this.aircraft;
    const q = this.tmpQ.set(this.renderQ.x, this.renderQ.y, this.renderQ.z, this.renderQ.w);
    const p = this.renderPos;
    const hub = this.tmpV.set(0, d.rotor.hubHeight, 0).applyQuaternion(q);
    const hubX = p.x + hub.x, hubY = p.y + hub.y, hubZ = p.z + hub.z;
    const ex = this.tmpV.copy(m.exhaust).applyQuaternion(q);
    const exX = p.x + ex.x, exY = p.y + ex.y, exZ = p.z + ex.z;
    const gearY = Math.min(...d.gear.points.map((g) => g[1]));
    const groundY = t.surfaceKind === 1 ? 0 : p.y + gearY - t.radarAlt;
    this.dustTimer -= dt;
    if (this.dustTimer <= 0) {
      this.dustTimer = 0.5;
      const s = this.world.surfaceAt(p.x, p.z);
      this.dust.setRGB(s.r * 1.1, s.g * 1.0, s.b * 0.95).lerp(new THREE.Color(0.62, 0.55, 0.43), 0.45);
      if (this.weather.snowing) this.dust.lerp(new THREE.Color(0.95, 0.96, 1), 0.8);
    }
    const w = this.rig.world;
    if (dt > 0) {
      const k = Math.min(1, dt * 10);
      this.camVel.x += ((w.x - this.camPrev.x) / dt - this.camVel.x) * k;
      this.camVel.y += ((w.y - this.camPrev.y) / dt - this.camVel.y) * k;
      this.camVel.z += ((w.z - this.camPrev.z) / dt - this.camVel.z) * k;
    }
    this.camPrev.x = w.x; this.camPrev.y = w.y; this.camPrev.z = w.z;
    const W = this.weather;
    this.effects.update({
      dt: simDt,
      hubX, hubY, hubZ,
      rotorRadius: d.rotor.diameter / 2,
      groundY,
      surface: t.surfaceKind,
      wash: h.rotorOk ? Math.min(1.3, t.thrust / (t.mass * 9.81)) * Math.min(1, h.rotorN) : 0,
      dust: this.dust,
      exX, exY, exZ,
      velX: h.vel.x, velY: h.vel.y, velZ: h.vel.z,
      health: h.health,
      destroyed: h.destroyed,
      windX: W.windX, windZ: W.windZ,
      precip: W.cur.precip,
      snow: W.snowing,
      camVX: Math.abs(this.camVel.x) > 400 ? 0 : this.camVel.x,
      camVY: Math.abs(this.camVel.y) > 400 ? 0 : this.camVel.y,
      camVZ: Math.abs(this.camVel.z) > 400 ? 0 : this.camVel.z,
      daylight: this.sky.daylight,
    });
  }

  /** The visual definition of the current aircraft (for audio). */
  get visual() {
    return AIRCRAFT_VISUAL[this.aircraft.id] ?? AIRCRAFT_VISUAL.medium;
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
    else if (a === 'nightVision') this.engine.nightVision.toggle();
    else if (a === 'respawn' && this.mode === 'fly') this.respawn();
    else if (a === 'fireMissile') this.fireMissile();
    else if (a === 'flares') this.releaseFlares();
    this.onAction?.(a);
  }

  private drawDebug(): void {
    const t = this.sim.heli.tel, h = this.sim.heli, r = this.engine.renderer.info.render;
    this.hud.textContent = [
      `SEED ${seedToString(this.world.seed)}  ${this.ready ? '' : 'GENERATING…'}`,
      `${this.aircraft.name}  ENG ${h.engine}  NR ${(t.rotorRpm * 100).toFixed(0)}%  TQ ${(t.torque * 100).toFixed(0)}%  mass ${t.mass.toFixed(0)}`,
      `IAS ${(t.airspeed / KTS).toFixed(0)} kt  ALT ${t.baroAlt.toFixed(0)}  RAD ${t.radarAlt.toFixed(1)}  VS ${t.verticalSpeed.toFixed(1)}  HDG ${(t.heading * RAD).toFixed(0)}`,
      `${(1000 / this.frameMs).toFixed(0)} fps  cpu ${this.cpuMs.toFixed(1)} ms  nodes ${this.terrain.stats.shown}  tris ${(r.triangles / 1000).toFixed(0)}k  calls ${r.calls}  cells ${this.props.stats.structureCells}/${this.props.stats.forestCells}`,
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

  /** The nearest compound still standing, for tests and screenshots. */
  debugCompound(): { x: number; y: number; z: number; half: number; name: string } | undefined {
    const p = this.sim.heli.pos;
    const live = [...this.combat.compounds.values()].filter((c) => !c.destroyed);
    live.sort((a, b) => Math.hypot(a.site.x - p.x, a.site.z - p.z) - Math.hypot(b.site.x - p.x, b.site.z - p.z));
    const s = live[0]?.site;
    return s && { x: s.x, y: s.y, z: s.z, half: s.half, name: s.name };
  }

  /** Teleport for tests and screenshots: hover at a world position and altitude above ground. */
  setPose(x: number, z: number, altitude: number, headingDeg = 0, speed = 0): void {
    this.spawn(this.aircraft, { x, z, heading: headingDeg / RAD }, altitude, speed);
  }
}
