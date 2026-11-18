import { TUNING } from '../data/tuning';
import { Autohover } from './autohover';
import { attitudeOf, clamp, G, lagAlpha, mulberry32, Quat, smoothstep, Vec3, type Attitude } from './math';
import { rotorAero, type RotorOut } from './rotor';
import {
  SurfaceKind,
  Warn,
  type Aircraft,
  type ControlInput,
  type EngineState,
  type Environment,
  type SphereContact,
  type SurfaceHit,
  type Telemetry,
} from './types';

const enum PointKind {
  Gear = 0,
  Hull = 1,
  Tail = 2,
  Rotor = 3,
}

interface ContactPoint {
  bx: number;
  by: number;
  bz: number;
  radius: number;
  kind: PointKind;
  k: number;
  c: number;
  touching: boolean;
  wallTouching: boolean;
  /** Friction anchor (world), valid while touching. */
  ax: number;
  ay: number;
  az: number;
  /** Current spring compression for rendering the gear, m. */
  compression: number;
}

/** Commands shared by the pilot and autohover for one step. */
export interface Commands {
  /** Body-axis rate commands, rad/s. */
  wx: number;
  wy: number;
  wz: number;
  /** Collective lever travel, 1/s. */
  leverRate: number;
}

/** Per-step flight state handed to the autohover so it does not recompute it. */
export interface FlightState {
  mass: number;
  rho: number;
  /** Air-relative hub speed along / across the rotor axis. */
  vc: number;
  vt: number;
  airspeed: number;
  hubAgl: number;
  up: Vec3;
  fwd: Vec3;
  right: Vec3;
  /** Tail rotor effectiveness this step (0–1.3). */
  tailEffect: number;
}

export interface SpawnOptions {
  x: number;
  y: number; // surface height, or altitude when airborne
  z: number;
  heading?: number; // rad
  airborne?: boolean;
  speed?: number; // m/s forward when airborne
  fuelFraction?: number;
  payload?: number; // kg, defaults to the standard load
}

const UP = new Vec3(0, 1, 0), FWD = new Vec3(0, 0, -1), RIGHT = new Vec3(1, 0, 0);

export class Helicopter {
  readonly ac: Aircraft;
  env: Environment;

  // Rigid body
  readonly pos = new Vec3();
  readonly vel = new Vec3();
  readonly q = new Quat();
  /** Body-axis angular velocity, rad/s. */
  readonly omega = new Vec3();

  // Powerplant and rotor
  engine: EngineState = 'off';
  /** Rotor speed as a fraction of nominal. */
  rotorN = 0;
  /** Engine torque at the rotor shaft, N·m. */
  qEng = 0;
  private startClock = 0;
  private startFromN = 0;
  private govInt = 0;
  /** Rotor azimuth for rendering, rad. */
  rotorAngle = 0;

  // Controls
  /** Collective lever, 0–1. Stays where it is left. */
  collective = 0;
  /** Blade pitch after the servo lag, rad. */
  theta: number;
  /** Induced velocity state, m/s. */
  vi = 0;
  pedalTrim = 0;
  brake = true;
  readonly autohover = new Autohover();
  /** Smoothed commands actually applied this step (for the model animation and HUD). */
  readonly cmd: Commands = { wx: 0, wy: 0, wz: 0, leverRate: 0 };

  // Loading
  fuel: number;
  payload: number;

  // Damage
  health = 1;
  tailRotorOk = true;
  rotorOk = true;
  destroyed = false;
  destroyedReason = '';

  time = 0;
  readonly tel: Telemetry;
  readonly points: ContactPoint[] = [];
  readonly att: Attitude = { heading: 0, pitch: 0, roll: 0 };

  private rng: () => number;
  private buffetPhase = 0;
  private failTimer = 0;
  /** Accumulated over-torque exposure, s. */
  overTorque = 0;
  private readonly ro = {} as RotorOut;
  private readonly fs: FlightState;

  // Scratch
  private readonly F = new Vec3();
  private readonly M = new Vec3();
  private readonly tw = new Vec3();
  private readonly up = new Vec3();
  private readonly fwd = new Vec3();
  private readonly right = new Vec3();
  private readonly wind = new Vec3();
  private readonly wind2 = new Vec3();
  private readonly vrel = new Vec3();
  private readonly vb = new Vec3();
  private readonly ww = new Vec3();
  private readonly t1 = new Vec3();
  private readonly t2 = new Vec3();
  private readonly t3 = new Vec3();
  private readonly hit: SurfaceHit = { height: 0, nx: 0, ny: 1, nz: 0, kind: SurfaceKind.Terrain };
  private readonly sc: SphereContact = { depth: 0, nx: 0, ny: 1, nz: 0 };

  constructor(ac: Aircraft, env: Environment, seed = 1) {
    this.ac = ac;
    this.env = env;
    this.rng = mulberry32(seed);
    const d = ac.data;
    this.fuel = d.fuel.capacity;
    this.payload = d.mass.payloadStd;
    this.theta = ac.thetaMin;
    this.fs = { mass: 0, rho: 1.225, vc: 0, vt: 0, airspeed: 0, hubAgl: 100, up: this.up, fwd: this.fwd, right: this.right, tailEffect: 1 };

    const nGear = d.gear.points.length;
    d.gear.points.forEach((p, i) => this.points.push(mkPoint(p[0], p[1], p[2], 0, PointKind.Gear, ac.gearK[i], ac.gearC[i])));
    const kHull = (ac.stdMass * TUNING.hull.contactOmega ** 2) / Math.max(2, d.hull.length * 0.5);
    const cHull = 2 * TUNING.hull.dampingRatio * Math.sqrt(kHull * ac.stdMass * 0.5);
    for (const p of d.hull) this.points.push(mkPoint(p[0], p[1], p[2], p[3], p[4] ? PointKind.Tail : PointKind.Hull, kHull, cHull));
    for (const p of ac.rotorTips) this.points.push(mkPoint(p[0], p[1], p[2], 0.15, PointKind.Rotor, kHull * 0.3, cHull * 0.3));
    void nGear;

    this.tel = {
      time: 0, mass: this.mass(), airspeed: 0, groundSpeed: 0, verticalSpeed: 0, radarAlt: 0, baroAlt: 0,
      heading: 0, pitch: 0, roll: 0, yawRate: 0, rotorRpm: 0, torque: 0, collective: 0, pedal: 0, thrust: 0, power: 0,
      gLoad: 1, onGround: false, gearLoad: 0, inGroundEffect: 0, translationalLift: 0, vortexRing: 0, bladeStall: 0,
      vibration: 0, fuel: this.fuel, fuelFraction: 1, fuelFlow: 0, health: 1, warnings: 0,
      surfaceKind: SurfaceKind.Terrain, lastImpact: 0, impactCount: 0,
    };
  }

  mass(): number {
    const d = this.ac.data;
    return d.mass.empty + d.mass.crew + this.payload + this.fuel;
  }

  /** Place the aircraft. On the ground it is set at rest height; airborne it starts in a trimmed hover or cruise. */
  spawn(o: SpawnOptions): void {
    const ac = this.ac, d = ac.data;
    this.fuel = d.fuel.capacity * (o.fuelFraction ?? 1);
    this.payload = o.payload ?? d.mass.payloadStd;
    this.q.setFromHPR(o.heading ?? 0, 0, 0);
    this.omega.set(0, 0, 0);
    this.vel.set(0, 0, 0);
    this.health = 1;
    this.tailRotorOk = true;
    this.rotorOk = true;
    this.destroyed = false;
    this.destroyedReason = '';
    this.pedalTrim = 0;
    this.govInt = 0;
    this.overTorque = 0;
    this.brake = true;
    this.autohover.reset();
    this.autohover.engaged = false;
    for (const p of this.points) {
      p.touching = false;
      p.wallTouching = false;
      p.compression = 0;
    }
    if (o.airborne) {
      this.pos.set(o.x, o.y, o.z);
      this.engine = 'running';
      this.rotorN = 1;
      this.qEng = ac.torqueRated * ac.computed.hoverPowerFraction;
      // Hover collective for the actual mass.
      const w = this.mass() * G;
      const rho = this.env.density(o.y);
      const vh = Math.sqrt(w / (2 * rho * ac.area));
      this.vi = vh;
      const ct = w / (rho * ac.area * (ac.omega0 * ac.R) ** 2);
      const th = 3 * ((2 * ct) / (ac.sigma * TUNING.rotor.liftSlope) + vh / (ac.omega0 * ac.R) / 2);
      this.theta = th;
      this.collective = clamp((th - ac.thetaMin) / (ac.thetaMax - ac.thetaMin), 0, 1);
      if (o.speed) this.q.rotate(this.t1.set(0, 0, -o.speed), this.vel);
    } else {
      this.pos.set(o.x, o.y + ac.restHeight + 0.02, o.z);
      this.engine = 'off';
      this.rotorN = 0;
      this.qEng = 0;
      this.vi = 0;
      this.collective = 0;
      this.theta = ac.thetaMin;
    }
    this.refreshAttitude();
  }

  toggleEngine(): void {
    if (this.destroyed) return;
    if (this.engine === 'off' || this.engine === 'failed') {
      if (this.fuel <= 0 || this.health < TUNING.damage.engineFailBelow) return;
      this.engine = 'starting';
      this.startClock = 0;
      this.startFromN = this.rotorN;
    } else {
      this.engine = 'off';
    }
  }

  /** Ground-crew repairs: restore health, and the tail rotor once the airframe is nearly whole. */
  repair(amount: number): void {
    if (this.destroyed || amount <= 0) return;
    this.health = Math.min(1, this.health + amount);
    if (this.health >= 0.9) this.tailRotorOk = true;
  }

  /** Most fuel the tanks can take without going over maximum takeoff weight (never less than what is aboard). */
  fuelLimit(): number {
    const d = this.ac.data;
    return Math.max(this.fuel, Math.min(d.fuel.capacity, d.mass.maxTakeoff - d.mass.empty - d.mass.crew - this.payload));
  }

  /** Pump fuel in, up to the limit. Returns the kilograms added. */
  refuel(kg: number): number {
    if (this.destroyed || kg <= 0) return 0;
    const add = Math.min(kg, this.fuelLimit() - this.fuel);
    if (add <= 0) return 0;
    this.fuel += add;
    return add;
  }

  /** Force an engine failure (damage, fuel exhaustion, or training). */
  failEngine(): void {
    if (this.engine !== 'off') this.engine = 'failed';
  }

  destroy(reason: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyedReason = reason;
    this.health = 0;
    this.engine = 'failed';
    this.rotorOk = false;
    this.autohover.engaged = false;
  }

  private refreshAttitude(): void {
    attitudeOf(this.q, this.att);
    this.q.rotate(UP, this.up);
    this.q.rotate(FWD, this.fwd);
    this.q.rotate(RIGHT, this.right);
  }

  /** Advance one fixed step. */
  step(dt: number, input: ControlInput): void {
    const ac = this.ac, d = ac.data, env = this.env;
    const tel = this.tel;
    this.time += dt;

    if (input.engineToggle) this.toggleEngine();
    if (input.brakeToggle) this.brake = !this.brake;
    if (input.autohoverToggle && !this.destroyed) this.autohover.toggle();

    this.refreshAttitude();
    const up = this.up, fwd = this.fwd, right = this.right;
    const mass = this.mass();
    const weight = mass * G;
    const rho = env.density(this.pos.y);
    const rhoRatio = rho / TUNING.atmosphere.rho0;

    // --- Surface under the CG -------------------------------------------------
    env.surface(this.pos.x, this.pos.z, this.pos.y, this.hit);
    const aglCg = this.pos.y - this.hit.height;
    tel.surfaceKind = this.hit.kind;
    const hubAgl = Math.max(0.3, aglCg + d.rotor.hubHeight * up.y);

    // --- Air-relative velocity ------------------------------------------------
    env.wind(this.pos.x, this.pos.y, this.pos.z, this.time, this.wind);
    this.vrel.copy(this.vel).sub(this.wind);
    this.q.rotateInv(this.vrel, this.vb);
    const vb = this.vb;
    const vc = vb.y;
    const vt = Math.hypot(vb.x, vb.z);
    const airspeed = this.vrel.len();

    const Y = TUNING.yaw;
    const tailEffect = this.tailRotorOk
      ? clamp(this.rotorN * this.rotorN, 0, 1.3) *
        (d.tail.lowSpeedAuthority + (1 - d.tail.lowSpeedAuthority) * smoothstep(0, Y.fullAuthoritySpeed, airspeed)) *
        rhoRatio
      : 0;

    const fs = this.fs;
    fs.mass = mass; fs.rho = rho; fs.vc = vc; fs.vt = vt; fs.airspeed = airspeed; fs.hubAgl = hubAgl; fs.tailEffect = tailEffect;

    // --- Commands: pilot first, autohover takes any axis the pilot is not holding
    const cmd = this.cmd;
    if (this.destroyed) {
      cmd.wx = cmd.wy = cmd.wz = cmd.leverRate = 0;
    } else {
      cmd.wx = -input.pitch * ac.pitchRate;
      cmd.wz = -input.roll * ac.rollRate;
      cmd.wy = -input.yaw * ac.yawRate;
      cmd.leverRate = input.collective * d.handling.collectiveRate;
      this.autohover.update(this, input, cmd, dt, fs);
    }

    this.collective = clamp(this.collective + cmd.leverRate * dt, 0, 1);
    const thetaCmd = ac.thetaMin + this.collective * (ac.thetaMax - ac.thetaMin);
    this.theta += (thetaCmd - this.theta) * lagAlpha(dt, TUNING.rotor.servoTau);

    // --- Main rotor -----------------------------------------------------------
    const omega = this.rotorN * ac.omega0;
    const ro = rotorAero(ac, this.theta, omega, rho, vc, vt, this.vi, hubAgl, this.ro);
    const RB = TUNING.retreatingBlade;
    const stallIndex = ro.mu + RB.loadingGain * Math.max(0, ro.ctSigma - RB.nominalLoading) * ro.mu;
    const rbs = this.rotorN > 0.5 ? smoothstep(ac.muStall, ac.muStall + RB.width, stallIndex) : 0;
    this.buffetPhase += dt * (11 + 7 * this.rng());
    const buffet = Math.sin(this.buffetPhase) * (TUNING.vortexRing.buffet * ro.vortexRing + 0.06 * rbs);
    let thrust = ro.thrust * (1 - RB.thrustLoss * rbs) * (1 + buffet);
    if (!this.rotorOk) thrust = 0;
    this.vi += (ro.viTarget - this.vi) * lagAlpha(dt, TUNING.rotor.inflowTau);

    // --- Engine, governor and rotor speed --------------------------------------
    const E = TUNING.engine;
    const Qr = ac.torqueRated;
    const mainPower = this.rotorOk ? ro.power * (1 + 0.6 * rbs) : 0;
    let qAero = 0;
    if (omega > 1) {
      qAero = mainPower / omega;
      qAero += TUNING.rotor.tailPowerFraction * Math.max(qAero, 0) + TUNING.rotor.accessoryFraction * Qr;
    }
    let qLoss = this.rotorN > 1e-4 ? E.friction * Qr : 0;
    if ((this.engine === 'off' || this.engine === 'failed') && this.rotorN < E.brakeBelow && tel.onGround) qLoss += E.rotorBrake * Qr;

    const powerFactor = this.health >= TUNING.damage.powerLossBelow ? 1 : 0.45 + 0.55 * (this.health / TUNING.damage.powerLossBelow);
    const pAvail = ac.powerMax * Math.pow(rhoRatio, TUNING.atmosphere.powerLapse) * powerFactor;
    let qCmd = 0;
    if (this.engine === 'starting') {
      this.startClock += dt;
      const s = clamp(this.startClock / d.engine.spoolTime, 0, 1);
      const nRef = this.startFromN + (1 - this.startFromN) * (1 - Math.pow(1 - s, 1.4));
      qCmd = clamp(qAero + qLoss + E.governorKp * (nRef - this.rotorN) * Qr, 0, ac.startTorque);
      if (this.rotorN >= E.flyHandover) {
        this.engine = 'running';
        this.govInt = 0;
      }
    } else if (this.engine === 'running') {
      const err = 1 - this.rotorN;
      const qLimit = Math.min(E.torqueLimit * Qr, (E.transientPower * pAvail) / Math.max(omega, 0.6 * ac.omega0));
      const qWant = qAero + qLoss + (E.governorKp * err + this.govInt) * Qr;
      qCmd = clamp(qWant, 0, qLimit);
      // Integrate only while the governor is in authority (no wind-up at the stops).
      if (qWant === qCmd || (qWant < 0 && err > 0) || (qWant > qLimit && err < 0)) {
        this.govInt = clamp(this.govInt + E.governorKi * err * dt, -0.25, 0.25);
      }
    }
    this.qEng += (qCmd - this.qEng) * lagAlpha(dt, this.engine === 'off' || this.engine === 'failed' ? 0.25 : d.engine.responseTau);
    this.rotorN = Math.max(0, this.rotorN + ((this.qEng - qAero - qLoss) / (ac.rotorInertia * ac.omega0)) * dt);
    this.rotorAngle = (this.rotorAngle + omega * dt) % (Math.PI * 2);
    if (this.rotorN > E.overspeed && this.rotorOk) this.applyDamage(0.25 * dt * d.damage.fragility, 'rotor overspeed');

    // Sustained over-torque wears the transmission.
    const over = this.qEng / Qr - 1.02;
    if (over > 0) this.overTorque = Math.min(this.overTorque + (dt * over) / (E.transientPower - 1.02), E.overTorqueSeconds + 1);
    else this.overTorque = Math.max(0, this.overTorque - 0.25 * dt);
    if (this.overTorque > E.overTorqueSeconds) this.applyDamage(E.overTorqueDamage * d.damage.fragility * dt, 'Transmission failure');

    // Fuel.
    const enginePower = this.qEng * omega;
    let fuelFlow = 0;
    if (this.engine === 'running' || this.engine === 'starting') {
      fuelFlow = ac.burnRated * (d.fuel.idleFraction + (1 - d.fuel.idleFraction) * clamp(enginePower / ac.powerMax, 0, 1.2));
      this.fuel -= fuelFlow * dt;
      if (this.fuel <= 0) {
        this.fuel = 0;
        this.failEngine();
      }
    }
    // Damage-induced engine failure, after a short delay.
    if (this.health < TUNING.damage.engineFailBelow && this.engine === 'running') {
      this.failTimer += dt;
      if (this.failTimer > 1.5) this.failEngine();
    } else this.failTimer = 0;

    // --- Forces ---------------------------------------------------------------
    const F = this.F.set(0, -weight, 0);
    F.addScaled(up, thrust);
    // Drag opposes the relative wind; the flat-plate area depends on which side faces it.
    if (airspeed > 1e-3) {
      const inv2 = 1 / (airspeed * airspeed);
      const fEff = (ac.fSide * vb.x * vb.x + ac.fVert * vb.y * vb.y + ac.fFwd * vb.z * vb.z) * inv2;
      F.addScaled(this.vrel, -0.5 * rho * airspeed * fEff);
    }

    // --- Moments (body axes) --------------------------------------------------
    const M = this.M;
    const auth = this.rotorOk ? clamp(this.rotorN * this.rotorN, 0, 1.3) : 0;
    const w = this.omega;
    M.x = (ac.Ixx * (cmd.wx - w.x) * auth) / d.handling.attTau;
    M.z = (ac.Izz * (cmd.wz - w.z) * auth) / d.handling.attTau;

    // Yaw: tail rotor against engine torque, plus the fin.
    const kr = ac.Iyy / d.handling.yawTau;
    const pStatic = ac.pedalHover + ac.pedalSlope * (this.collective - ac.hoverCollective) + this.pedalTrim;
    const pRate = (kr * (cmd.wy - w.y)) / (ac.tailTorqueMax * d.tail.lowSpeedAuthority);
    const pedal = clamp(pStatic + pRate, -0.7, 1);
    const vTailX = vb.x + w.y * d.tail.arm;
    const finTorque = -0.5 * rho * ac.finArea * airspeed * vTailX * d.tail.arm;
    M.y = ac.tailTorqueMax * tailEffect * pedal - this.qEng + finTorque;
    // Small aerodynamic damping so a dead rotor does not leave the body spinning forever.
    const aeroDamp = 0.02 * rho * (airspeed + 5);
    M.x -= ac.Ixx * aeroDamp * w.x * 0.1;
    M.y -= ac.Iyy * aeroDamp * w.y * 0.1;
    M.z -= ac.Izz * aeroDamp * w.z * 0.1;

    // Retreating-blade stall: roll toward the retreating side, pitch up.
    if (rbs > 0) {
      M.x += (ac.Ixx * rbs * RB.pitchRate * auth) / d.handling.attTau;
      M.z += (ac.Izz * rbs * RB.rollRate * auth) / d.handling.attTau;
    }

    // Gusts: a vertical-wind difference across the disc rolls and pitches the aircraft.
    const gw = this.wind;
    if (auth > 0.3 && (Math.abs(gw.y) > 1e-3 || gw.x !== 0 || gw.z !== 0)) {
      const R = ac.R;
      env.wind(this.pos.x + right.x * R, this.pos.y, this.pos.z + right.z * R, this.time, this.wind2);
      const dRight = this.wind2.y - gw.y;
      env.wind(this.pos.x + fwd.x * R, this.pos.y, this.pos.z + fwd.z * R, this.time, this.wind2);
      const dFwd = this.wind2.y - gw.y;
      M.z += ac.Izz * TUNING.gust.momentGain * dRight;
      M.x += ac.Ixx * TUNING.gust.momentGain * dFwd;
    }

    // --- Contact --------------------------------------------------------------
    const tw = this.tw.set(0, 0, 0);
    let gearForce = 0;
    let radarAlt = aglCg - ac.restHeight;
    let anyGear = false;
    const nearStructure = env.collide ? env.collide(this.pos.x, this.pos.y, this.pos.z, ac.R + 4, this.sc) : false;
    const speed = this.vel.len();
    if (aglCg < ac.R + 12 + speed * 0.5 || nearStructure) {
      this.q.rotate(w, this.ww);
      radarAlt = Infinity;
      for (const p of this.points) {
        const pw = this.q.rotate(this.t1.set(p.bx, p.by, p.bz), this.t1);
        const px = this.pos.x + pw.x, py = this.pos.y + pw.y - p.radius, pz = this.pos.z + pw.z;
        // Velocity of the contact point.
        const vP = this.t2.cross(this.ww, pw).add(this.vel);
        env.surface(px, pz, py, this.hit);
        const depth = this.hit.height - py;
        if (p.kind === PointKind.Gear) radarAlt = Math.min(radarAlt, -depth);

        let fx = 0, fy = 0, fz = 0;
        if (depth > 0) {
          const nx = this.hit.nx, ny = this.hit.ny, nz = this.hit.nz;
          const vn = vP.x * nx + vP.y * ny + vP.z * nz;
          const dn = depth * ny;
          if (this.hit.kind === SurfaceKind.Water) {
            // Water: buoyancy and heavy drag. A swamped hull is lost.
            const share = mass / this.points.length;
            const lift = TUNING.water.buoyancy * share * G * Math.min(dn, 1.5);
            const dragK = TUNING.water.drag * share;
            fx = -dragK * vP.x; fy = lift - dragK * vP.y; fz = -dragK * vP.z;
            if (p.kind !== PointKind.Gear && p.kind !== PointKind.Rotor && dn > TUNING.water.ditchDepth) this.destroy('Ditched in water');
            if (p.kind === PointKind.Rotor && this.rotorN > 0.25) this.destroy('Rotor struck the water');
            if (!p.touching && -vn > 1) this.onImpact(p.kind, -vn * 0.6);
            p.touching = true;
            p.compression = 0;
          } else {
            if (!p.touching) {
              this.onImpact(p.kind, Math.max(0, -vn));
              p.ax = px; p.ay = py; p.az = pz;
            }
            p.touching = true;
            if (p.kind === PointKind.Rotor && this.rotorN > 0.25) this.destroy('Rotor strike');
            let fn = p.k * Math.min(dn, 3) - p.c * vn;
            const G_ = TUNING.gear;
            if (p.kind === PointKind.Gear) {
              p.compression = Math.min(dn, d.gear.stroke);
              if (dn > d.gear.stroke) fn += G_.bottomingFactor * p.k * (dn - d.gear.stroke);
            }
            if (fn < 0) fn = 0;
            // Stick/slip friction against an anchor.
            const mu = p.kind === PointKind.Gear ? G_.friction : TUNING.hull.friction;
            const kt = p.k * G_.stickFactor;
            let sx = -(px - p.ax) * kt, sy = -(py - p.ay) * kt, sz = -(pz - p.az) * kt;
            // Remove the normal component of the spring force.
            const sn = sx * nx + sy * ny + sz * nz;
            sx -= sn * nx; sy -= sn * ny; sz -= sn * nz;
            // Tangential damping.
            const ct = p.c * 0.8;
            sx -= ct * (vP.x - vn * nx); sy -= ct * (vP.y - vn * ny); sz -= ct * (vP.z - vn * nz);
            let limit = mu * fn;
            if (p.kind === PointKind.Gear && d.gear.type === 'wheels' && !this.brake) {
              // Free-rolling wheels: little grip along the heading, full grip sideways.
              const along = sx * fwd.x + sy * fwd.y + sz * fwd.z;
              const maxAlong = G_.rollingFriction * fn;
              const clipped = clamp(along, -maxAlong, maxAlong);
              sx += (clipped - along) * fwd.x; sy += (clipped - along) * fwd.y; sz += (clipped - along) * fwd.z;
              if (clipped !== along) {
                // Let the anchor roll forward with the wheel.
                const slip = (px - p.ax) * fwd.x + (pz - p.az) * fwd.z;
                p.ax += slip * fwd.x; p.az += slip * fwd.z;
              }
            }
            const sMag = Math.hypot(sx, sy, sz);
            if (sMag > limit) {
              const s = limit / sMag;
              sx *= s; sy *= s; sz *= s;
              // Sliding: drag the anchor along so the spring stays at the friction limit.
              p.ax = px + sx / kt; p.ay = py + sy / kt; p.az = pz + sz / kt;
            }
            fx = nx * fn + sx; fy = ny * fn + sy; fz = nz * fn + sz;
            if (p.kind === PointKind.Gear) {
              gearForce += fn * ny;
              anyGear = true;
            }
          }
        } else {
          p.touching = false;
          p.compression = 0;
        }

        // Walls and other obstacles.
        if (nearStructure && env.collide && p.kind !== PointKind.Gear) {
          const r = Math.max(p.radius, 0.25);
          if (env.collide(px, py + p.radius, pz, r, this.sc)) {
            const c = this.sc;
            const vn = vP.x * c.nx + vP.y * c.ny + vP.z * c.nz;
            if (!p.wallTouching) this.onImpact(p.kind, Math.max(0, -vn));
            p.wallTouching = true;
            if (p.kind === PointKind.Rotor && this.rotorN > 0.25) this.destroy('Rotor strike');
            // A point this far inside a solid has not bounced off it: the aircraft is wrecked.
            if (c.depth > 2.5 && p.kind !== PointKind.Rotor) this.destroy('Crashed into a structure');
            const fn = Math.max(0, p.k * Math.min(c.depth, 1.2) - p.c * vn);
            const tvx = vP.x - vn * c.nx, tvy = vP.y - vn * c.ny, tvz = vP.z - vn * c.nz;
            const tv = Math.hypot(tvx, tvy, tvz) + 1e-6;
            const ft = Math.min(TUNING.hull.friction * fn, p.c * tv);
            fx += c.nx * fn - (tvx / tv) * ft; fy += c.ny * fn - (tvy / tv) * ft; fz += c.nz * fn - (tvz / tv) * ft;
          } else p.wallTouching = false;
        }

        if (fx !== 0 || fy !== 0 || fz !== 0) {
          F.x += fx; F.y += fy; F.z += fz;
          this.t3.set(fx, fy, fz);
          tw.add(this.t3.cross(pw, this.t3));
        }
      }
      if (!isFinite(radarAlt)) radarAlt = aglCg - ac.restHeight;
    } else {
      for (const p of this.points) {
        p.touching = false;
        p.wallTouching = false;
        p.compression = 0;
      }
    }
    // Contact torque into body axes.
    this.q.rotateInv(tw, tw);
    M.add(tw);

    // --- Integrate ------------------------------------------------------------
    const inv = 1 / mass;
    const axw = F.x * inv, ayw = F.y * inv, azw = F.z * inv;
    this.vel.x += axw * dt; this.vel.y += ayw * dt; this.vel.z += azw * dt;
    this.pos.addScaled(this.vel, dt);
    const wxd = (M.x - (ac.Izz - ac.Iyy) * w.y * w.z) / ac.Ixx;
    const wyd = (M.y - (ac.Ixx - ac.Izz) * w.z * w.x) / ac.Iyy;
    const wzd = (M.z - (ac.Iyy - ac.Ixx) * w.x * w.y) / ac.Izz;
    w.x += wxd * dt; w.y += wyd * dt; w.z += wzd * dt;
    // Keep the state finite whatever a contact did: a wreck may tumble, but not at any speed.
    const sp = this.vel.len();
    if (sp > 350) this.vel.scale(350 / sp);
    const ws = w.len();
    if (ws > 25) w.scale(25 / ws);
    this.q.integrateBody(w.x, w.y, w.z, dt);

    // --- Telemetry ------------------------------------------------------------
    this.refreshAttitude();
    tel.time = this.time;
    tel.mass = mass;
    tel.airspeed = airspeed;
    tel.groundSpeed = Math.hypot(this.vel.x, this.vel.z);
    tel.verticalSpeed = this.vel.y;
    tel.radarAlt = Math.max(0, radarAlt);
    tel.baroAlt = this.pos.y;
    tel.heading = this.att.heading;
    tel.pitch = this.att.pitch;
    tel.roll = this.att.roll;
    tel.yawRate = -w.y;
    tel.rotorRpm = this.rotorN;
    tel.torque = this.qEng / Qr;
    tel.collective = this.collective;
    tel.pedal = pedal;
    tel.thrust = thrust;
    tel.power = enginePower;
    tel.gLoad = (axw * up.x + (ayw + G) * up.y + azw * up.z) / G;
    tel.onGround = anyGear;
    tel.gearLoad = gearForce / weight;
    tel.inGroundEffect = clamp((1 - ro.groundFactor) / 0.22, 0, 1);
    tel.translationalLift = this.rotorN > 0.5 ? smoothstep(0.5, 1.6, ro.vtBar) : 0;
    tel.vortexRing = ro.vortexRing;
    tel.bladeStall = rbs;
    tel.vibration = clamp(ro.vortexRing * 0.8 + rbs + (1 - this.health) * 0.35 + (this.rotorN > 0.3 && !this.tailRotorOk ? 0.3 : 0), 0, 1);
    tel.fuel = this.fuel;
    tel.fuelFraction = this.fuel / d.fuel.capacity;
    tel.fuelFlow = fuelFlow;
    tel.health = this.health;

    let warn = 0;
    const running = this.engine === 'running';
    const flying = !anyGear || gearForce < 0.5 * weight;
    if (this.rotorN < E.greenMin && (flying ? this.rotorN > 0.05 || !anyGear : running && this.collective > 0.2)) warn |= Warn.LowRotorRpm;
    if (this.rotorN > E.greenMax) warn |= Warn.HighRotorRpm;
    if (tel.torque > 1.02) warn |= Warn.OverTorque;
    if (tel.fuelFraction < 0.12) warn |= Warn.LowFuel;
    if (this.engine === 'failed' || (this.engine === 'off' && flying && this.rotorN > 0.2)) warn |= Warn.EngineOut;
    if (ro.vortexRing > 0.25) warn |= Warn.VortexRing;
    if (rbs > 0.15) warn |= Warn.BladeStall;
    if (airspeed > ac.vne) warn |= Warn.Overspeed;
    if (flying && this.vel.y < -6 && tel.radarAlt < 12 * -this.vel.y && tel.radarAlt < 150) warn |= Warn.SinkRate;
    if (!this.tailRotorOk) warn |= Warn.TailRotor;
    if (this.engine === 'starting' && this.collective > 0.12) warn |= Warn.LowerCollective;
    if (this.health < 0.6) warn |= Warn.Damage;
    if (this.autohover.engaged && !this.autohover.active && !anyGear) warn |= Warn.AutohoverUnavailable;
    if (mass > d.mass.maxTakeoff) warn |= Warn.Overweight;
    tel.warnings = warn;
  }

  /** Damage from outside the flight model (weapons). `crit` is the chance it takes out the tail rotor. */
  takeHit(amount: number, reason: string, crit = 0, roll = Math.random()): void {
    if (this.destroyed) return;
    if (roll < crit && this.rotorN > 0.3) this.tailRotorOk = false;
    this.applyDamage(amount, reason);
  }

  private applyDamage(amount: number, reason: string): void {
    if (amount <= 0 || this.destroyed) return;
    this.health -= amount;
    if (this.health <= 0) this.destroy(reason);
  }

  /** A contact point has just touched something at `speed` (normal component, m/s). */
  private onImpact(kind: PointKind, speed: number): void {
    const d = this.ac.data;
    if (speed > this.tel.lastImpact || speed > 0.3) {
      this.tel.lastImpact = speed;
      this.tel.impactCount++;
    }
    if (this.destroyed) return;
    if (kind === PointKind.Gear) {
      // At or past the crash sink rate the gear collapses; below it a firm landing only dents the airframe.
      if (speed >= d.damage.crash) this.destroy('Crashed');
      const x = (speed - d.damage.hardLanding) / (d.damage.crash - d.damage.hardLanding);
      if (x > 0) this.applyDamage(((0.08 + 0.7 * Math.pow(x, 1.6)) * d.damage.fragility) / d.gear.points.length, 'Hard landing');
    } else if (kind === PointKind.Rotor) {
      if (this.rotorN <= 0.25 && speed > 2) this.applyDamage(0.2 * d.damage.fragility, 'Rotor damage');
    } else {
      if (speed > TUNING.hull.scuffSpeed) {
        const x = speed / d.damage.crash;
        const knock = 0.9 * x * x * d.damage.fragility;
        this.applyDamage(speed < d.damage.crash ? Math.min(knock, TUNING.hull.maxKnock) : knock, kind === PointKind.Tail ? 'Tail strike' : 'Crashed');
      }
      if (kind === PointKind.Tail && speed > TUNING.damage.tailStrikeSpeed) this.tailRotorOk = false;
    }
  }
}

function mkPoint(bx: number, by: number, bz: number, radius: number, kind: PointKind, k: number, c: number): ContactPoint {
  return { bx, by, bz, radius, kind, k, c, touching: false, wallTouching: false, ax: 0, ay: 0, az: 0, compression: 0 };
}
