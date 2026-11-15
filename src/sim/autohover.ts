import { TUNING } from '../data/tuning';
import type { Commands, FlightState, Helicopter } from './helicopter';
import { clamp, DEG, G, lagAlpha, lerp, smoothstep, Vec3, wrapPi } from './math';
import { groundFactor, inflowRatio, pitchForThrust, stallLimit, vortexRingFactor } from './rotor';
import type { ControlInput } from './types';

export type AutohoverMode = 'off' | 'standby' | 'brake' | 'hold' | 'pilot';

/**
 * Autohover. Writes only to the channels the pilot has: attitude-rate commands,
 * the collective lever and pedal trim. Each axis belongs to the pilot while its
 * key is held and is recaptured when the key is released.
 */
export class Autohover {
  /** Switched on by the pilot. Stays on until toggled off. */
  engaged = false;
  /** Engaged and actually flying the aircraft this step. */
  active = false;
  mode: AutohoverMode = 'off';

  holdX: number | null = null;
  holdZ = 0;
  holdAlt: number | null = null;
  holdHeading: number | null = null;

  private windX = 0;
  private windZ = 0;
  private thrustInt = 0;
  private readonly ud = new Vec3();
  private readonly ub = new Vec3();

  toggle(): void {
    this.engaged = !this.engaged;
    this.reset();
  }

  reset(): void {
    this.active = false;
    this.holdX = null;
    this.holdAlt = null;
    this.holdHeading = null;
    this.windX = this.windZ = 0;
    this.thrustInt = 0;
    this.mode = this.engaged ? 'standby' : 'off';
  }

  update(h: Helicopter, input: ControlInput, cmd: Commands, dt: number, fs: FlightState): void {
    if (!this.engaged) {
      this.active = false;
      this.mode = 'off';
      return;
    }
    const ac = h.ac, d = ac.data, A = TUNING.autohover, E = TUNING.engine;
    // Engaging needs RPM in the green. Once flying it rides through a transient droop
    // or flare overspeed rather than dropping the aircraft mid-manoeuvre.
    const nLow = this.active ? A.dropoutRpm : E.greenMin;
    const nHigh = this.active ? E.overspeed : E.greenMax;
    const available = h.engine === 'running' && h.rotorN >= nLow && h.rotorN <= nHigh && h.rotorOk;
    const planted = h.tel.onGround && h.tel.gearLoad > 0.5;
    if (!available || planted) {
      // Standing by: no commands, and nothing remembered from before.
      if (this.active || this.holdX !== null || this.holdAlt !== null) this.reset();
      this.active = false;
      this.mode = 'standby';
      return;
    }
    this.active = true;

    const weight = fs.mass * G;
    const omega = h.rotorN * ac.omega0;
    const up = fs.up;

    // --- What the rotor can deliver right now, in this flight state ----------
    const RT = TUNING.rotor;
    const vTip = omega * ac.R;
    const mu = fs.vt / vTip;
    const kG = groundFactor(ac.R, fs.hubAgl, fs.vt, h.vi);
    // Blade-pitch limit: thrust at full collective with the present inflow.
    const ctFull = stallLimit(
      0.5 * ac.sigma * RT.liftSlope * ((ac.thetaMax / 3) * (1 + 1.5 * mu * mu) - (fs.vc + h.vi * kG) / (2 * vTip)),
      ac.ctMax,
    );
    const tPitch = Math.max(fs.rho * ac.area * vTip * vTip * ctFull, 0.2 * weight);
    // Power limit: the thrust whose shaft power fits the engine, counting what the
    // airflow gives back when the disc is tilted against the motion.
    const pAvail = ac.powerMax * Math.pow(fs.rho / TUNING.atmosphere.rho0, TUNING.atmosphere.powerLapse);
    // Budget transient power while RPM is healthy; give it back as the rotor droops.
    const transient =
      lerp(A.powerDrooped, A.powerTransient, smoothstep(0.955, 0.985, h.rotorN)) -
      A.droopBackoff * smoothstep(0.955, 0.925, h.rotorN);
    const profile = (fs.rho * ac.area * vTip ** 3 * ac.sigma * RT.cd0 * (1 + 4.65 * mu * mu)) / 8;
    const budget = (transient * pAvail - RT.accessoryFraction * ac.powerMax) / (1 + RT.tailPowerFraction) - profile;
    const rotorPower = (t: number): number => {
      const vh = Math.max(0.5, Math.sqrt(t / (2 * fs.rho * ac.area)));
      return RT.kappa * t * vh * inflowRatio(fs.vc / vh, fs.vt / vh) * kG + t * fs.vc;
    };
    let tPower = tPitch;
    if (rotorPower(tPitch) > budget) {
      let lo = 0.2 * weight, hi = tPitch;
      for (let i = 0; i < 14; i++) {
        const mid = 0.5 * (lo + hi);
        if (rotorPower(mid) > budget) hi = mid;
        else lo = mid;
      }
      tPower = lo;
    }
    const tMax = Math.min(tPitch, tPower);
    const tPlan = A.thrustReserve * tMax;

    // Lean limit: keep enough thrust to hold height, and ease off if the rotor is being driven fast.
    let tiltLim = Math.min(ac.ahMaxTilt, Math.acos(clamp(weight / tPlan, 0.3, 1)));
    tiltLim = Math.max(tiltLim, 0.2);
    if (h.rotorN > 1.03) tiltLim *= clamp(1 - (h.rotorN - 1.03) / 0.07, 0.3, 1);
    const aMax = G * Math.tan(tiltLim);

    // --- Loop gains from the aircraft's own response --------------------------
    const tauEff = d.handling.attTau / (1 + A.rateLead);
    const kAtt = A.attitudeGainFactor / tauEff;
    const kVel = kAtt * A.velocityToAttitude;
    const kPos = kVel * A.positionToVelocity;

    const pilotPitch = input.pitch !== 0;
    const pilotRoll = input.roll !== 0;
    const pilotColl = input.collective !== 0;
    const pilotYaw = input.yaw !== 0;

    // --- Vertical: thrust needed to cancel sink and hold height ----------------
    let ayDes = 0;
    if (pilotColl) {
      this.holdAlt = null;
      this.thrustInt = 0;
    } else {
      const vy = h.vel.y;
      let vyDes = 0;
      if (this.holdAlt === null) {
        if (Math.abs(vy) < A.captureVerticalSpeed) this.holdAlt = h.pos.y + vy / A.verticalGain;
      } else {
        const e = this.holdAlt - h.pos.y;
        const lim = Math.min(A.maxVerticalSpeed, Math.sqrt(2 * 0.35 * G * Math.abs(e)) + 0.2);
        vyDes = clamp(A.altitudeGain * e, -lim, lim);
      }
      ayDes = clamp(A.verticalGain * (vyDes - vy), -A.maxVerticalAccel * G, A.maxVerticalAccel * G);
      if (Math.abs(vyDes - vy) < 1.5) {
        this.thrustInt = clamp(this.thrustInt + A.thrustIntegral * fs.mass * (vyDes - vy) * dt, -0.3 * weight, 0.3 * weight);
      }
    }

    // --- Horizontal: desired acceleration → lean → rate commands ---------------
    const vx = h.vel.x, vz = h.vel.z;
    const speed = Math.hypot(vx, vz);
    // Heading-frame axes on the ground plane.
    let fx = fs.fwd.x, fz = fs.fwd.z;
    const fl = Math.hypot(fx, fz);
    if (fl > 0.2) {
      fx /= fl; fz /= fl;
    } else {
      // Nose near vertical: take the horizontal part of the tail-to-head axis instead.
      fx = -up.x; fz = -up.z;
      const l = Math.hypot(fx, fz) || 1;
      fx /= l; fz /= l;
    }
    const rx = -fz, rz = fx;

    // Vortex-ring protection: while sinking fast with no airspeed, stopping dead would
    // sit the rotor in its own wake. Keep some speed on until the sink is arrested.
    const vhEst = Math.sqrt(weight / (2 * fs.rho * ac.area));
    const escape = smoothstep(A.escapeSinkStart * vhEst, A.escapeSinkFull * vhEst, -h.vel.y);
    let tvx = 0, tvz = 0;
    if (escape > 0) {
      const vEsc = A.escapeSpeed * vhEst * escape;
      if (speed > 1) {
        tvx = (vx / speed) * vEsc; tvz = (vz / speed) * vEsc;
      } else {
        tvx = fx * vEsc; tvz = fz * vEsc;
      }
    }

    let ax: number, az: number;
    if (pilotPitch || pilotRoll) {
      this.holdX = null;
      ax = -kVel * vx + this.windX;
      az = -kVel * vz + this.windZ;
      this.mode = 'pilot';
    } else {
      if (this.holdX === null && speed < A.captureSpeed && escape === 0) {
        // Hold where the remaining drift will carry it, so it settles without backing up.
        this.holdX = h.pos.x + vx / kVel;
        this.holdZ = h.pos.z + vz / kVel;
      }
      if (escape > 0) this.holdX = null;
      if (this.holdX === null) {
        ax = kVel * (tvx - vx) + this.windX;
        az = kVel * (tvz - vz) + this.windZ;
        this.mode = 'brake';
      } else {
        const ex = this.holdX - h.pos.x, ez = this.holdZ - h.pos.z;
        const e = Math.hypot(ex, ez);
        const vLim = Math.min(12, Math.sqrt(aMax * e) + 0.3);
        const s = e > 1e-6 ? Math.min(kPos * e, vLim) / e : 0;
        const dvx = ex * s - vx, dvz = ez * s - vz;
        // Lean into steady wind.
        this.windX += A.windIntegral * dvx * dt;
        this.windZ += A.windIntegral * dvz * dt;
        const wl = Math.hypot(this.windX, this.windZ);
        if (wl > A.maxWindAccel) {
          this.windX *= A.maxWindAccel / wl;
          this.windZ *= A.maxWindAccel / wl;
        }
        ax = kVel * dvx + this.windX;
        az = kVel * dvz + this.windZ;
        this.mode = 'hold';
      }
    }
    // Hand back whichever axis the pilot is holding.
    if (pilotPitch) {
      const along = ax * fx + az * fz;
      ax -= along * fx; az -= along * fz;
    }
    if (pilotRoll) {
      const across = ax * rx + az * rz;
      ax -= across * rx; az -= across * rz;
    }
    let aMag = Math.hypot(ax, az);
    if (aMag > aMax) {
      ax *= aMax / aMag; az *= aMax / aMag;
      aMag = aMax;
    }
    // Braking leans the disc back into the airflow. If the aircraft is also sinking, a hard
    // lean would put the rotor into its own wake, so take the steepest lean that stays clear.
    if (h.vel.y < -1 && speed > 0.5 && ax * vx + az * vz < 0 && aMag > 1e-3) {
      const vhPlan = Math.sqrt(tPlan / (2 * fs.rho * ac.area));
      let lean = Math.atan2(aMag, G);
      for (let i = 0; i < 6 && lean > A.minBrakeTilt * DEG; i++) {
        const sn = Math.sin(lean), cs = Math.cos(lean);
        const vcB = (h.vel.y * cs - speed * sn) / vhPlan;
        const vtB = Math.abs(speed * cs + h.vel.y * sn) / vhPlan;
        if (vortexRingFactor(vcB, vtB) <= A.maxBrakeRing) break;
        lean *= 0.8;
      }
      const allowed = G * Math.tan(lean);
      if (aMag > allowed) {
        ax *= allowed / aMag; az *= allowed / aMag;
      }
    }

    // Desired rotor axis, then the body rotation that gets there.
    const vertical = Math.max(G + ayDes, 0.4 * G);
    const hLim = Math.tan(tiltLim) * vertical;
    const hMag = Math.hypot(ax, az);
    const hs = hMag > hLim ? hLim / hMag : 1;
    this.ud.set(ax * hs, vertical, az * hs).normalize();
    if (!pilotColl) {
      // Thrust for the vertical demand at the present lean. While the disc still leans the
      // wrong way, back off by the part of the thrust that would push the drift faster.
      let tDes = (fs.mass * (G + ayDes)) / Math.max(up.y, 0.35);
      const wrongWay = ax * hs * up.x + az * hs * up.z;
      if (wrongWay < 0 && !pilotPitch && !pilotRoll) tDes = Math.max(tDes + fs.mass * wrongWay, 0.5 * weight);
      tDes = clamp(tDes + this.thrustInt, 0.05 * weight, tMax);
      const thetaDes = pitchForThrust(ac, tDes, omega, fs.rho, fs.vc, fs.vt, fs.hubAgl);
      const leverDes = clamp((thetaDes - ac.thetaMin) / (ac.thetaMax - ac.thetaMin), 0, 1);
      cmd.leverRate = clamp((leverDes - h.collective) / dt, -A.leverRate, A.leverRate);
    }
    h.q.rotateInv(this.ud, this.ub);
    const ub = this.ub;
    const errX = Math.atan2(ub.z, ub.y);
    const errZ = Math.atan2(-ub.x, ub.y);

    // While a cyclic key is held the pilot flies that axis, up to a lean limit so that
    // holding the key gives steady forward flight instead of a loop.
    const lim = A.pilotTiltLimit * DEG;
    h.q.rotateInv(this.ud.set(0, 1, 0), this.ud);
    if (pilotPitch) {
      const noseUp = -Math.atan2(this.ud.z, this.ud.y);
      const room = cmd.wx < 0 ? lim + noseUp : lim - noseUp;
      cmd.wx = Math.sign(cmd.wx) * Math.min(Math.abs(cmd.wx), kAtt * room);
    }
    if (pilotRoll) {
      const rollLeft = Math.atan2(this.ud.x, this.ud.y);
      const room = cmd.wz > 0 ? lim - rollLeft : lim + rollLeft;
      cmd.wz = Math.sign(cmd.wz) * Math.min(Math.abs(cmd.wz), kAtt * room);
    }

    const maxRate = ac.ahMaxRate;
    const cmdLim = d.autohover.authority * maxRate;
    const alpha = (0.55 * cmdLim) / d.handling.attTau;
    const w = h.omega;
    if (!pilotPitch) {
      const want = Math.sign(errX) * Math.min(kAtt * Math.abs(errX), Math.sqrt(2 * alpha * Math.abs(errX)), maxRate);
      cmd.wx = clamp(want + A.rateLead * (want - w.x), -cmdLim, cmdLim);
    }
    if (!pilotRoll) {
      const want = Math.sign(errZ) * Math.min(kAtt * Math.abs(errZ), Math.sqrt(2 * alpha * Math.abs(errZ)), maxRate);
      cmd.wz = clamp(want + A.rateLead * (want - w.z), -cmdLim, cmdLim);
    }

    // --- Yaw: trim follows the measured torque, heading hold on top -------------
    if (fs.tailEffect > 0.2) {
      const needed = h.qEng / (ac.tailTorqueMax * fs.tailEffect);
      const mix = ac.pedalHover + ac.pedalSlope * (h.collective - ac.hoverCollective);
      h.pedalTrim += (clamp(needed - mix, -0.8, 0.8) - h.pedalTrim) * lagAlpha(dt, A.trimTau);
    }
    if (pilotYaw) {
      this.holdHeading = null;
    } else {
      const yawTauEff = d.handling.yawTau / 3;
      const kHead = Math.min(A.headingGain, 0.45 / yawTauEff);
      let want = 0;
      if (this.holdHeading === null) {
        if (Math.abs(w.y) < A.captureYawRate) this.holdHeading = h.att.heading;
      } else {
        // Heading increases clockwise, body yaw rate is positive anticlockwise.
        want = clamp(-kHead * wrapPi(this.holdHeading - h.att.heading), -1.5 * ac.yawRate, 1.5 * ac.yawRate);
      }
      cmd.wy = clamp(want + 2 * (want - w.y), -3 * ac.yawRate, 3 * ac.yawRate);
    }
  }
}
