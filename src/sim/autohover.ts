import { TUNING } from '../data/tuning';
import type { Commands, FlightState, Helicopter } from './helicopter';
import { clamp, G, lagAlpha, smoothstep, Vec3, wrapPi } from './math';
import { hoverThrust, pitchForThrust } from './rotor';
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

    // --- What the rotor can deliver right now ---------------------------------
    const tPitch = hoverThrust(ac, ac.thetaMax, omega, fs.rho);
    const vTip = omega * ac.R;
    const profile = (fs.rho * ac.area * vTip ** 3 * ac.sigma * TUNING.rotor.cd0) / 8;
    const pAvail = ac.powerMax * Math.pow(fs.rho / TUNING.atmosphere.rho0, TUNING.atmosphere.powerLapse);
    const tPower = Math.pow((Math.max(1.2 * pAvail - profile, 0.1 * pAvail) * Math.sqrt(2 * fs.rho * ac.area)) / TUNING.rotor.kappa, 2 / 3);
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
        if (Math.abs(vy) < A.captureVerticalSpeed) this.holdAlt = h.pos.y;
      } else {
        const e = this.holdAlt - h.pos.y;
        const lim = Math.min(A.maxVerticalSpeed, Math.sqrt(2 * 0.35 * G * Math.abs(e)) + 0.2);
        vyDes = clamp(A.altitudeGain * e, -lim, lim);
      }
      ayDes = clamp(A.verticalGain * (vyDes - vy), -A.maxVerticalAccel * G, A.maxVerticalAccel * G);
      if (Math.abs(vyDes - vy) < 1.5) {
        this.thrustInt = clamp(this.thrustInt + A.thrustIntegral * fs.mass * (vyDes - vy) * dt, -0.3 * weight, 0.3 * weight);
      }
      const tDes = clamp((fs.mass * (G + ayDes)) / Math.max(up.y, 0.35) + this.thrustInt, 0.05 * weight, tMax);
      const thetaDes = pitchForThrust(ac, tDes, omega, fs.rho, fs.vc, fs.vt, fs.hubAgl);
      const leverDes = clamp((thetaDes - ac.thetaMin) / (ac.thetaMax - ac.thetaMin), 0, 1);
      cmd.leverRate = clamp((leverDes - h.collective) / dt, -A.leverRate, A.leverRate);
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
        this.holdX = h.pos.x;
        this.holdZ = h.pos.z;
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
    const aMag = Math.hypot(ax, az);
    if (aMag > aMax) {
      ax *= aMax / aMag; az *= aMax / aMag;
    }

    // Desired rotor axis, then the body rotation that gets there.
    const vertical = Math.max(G + ayDes, 0.4 * G);
    const hLim = Math.tan(tiltLim) * vertical;
    const hMag = Math.hypot(ax, az);
    const hs = hMag > hLim ? hLim / hMag : 1;
    this.ud.set(ax * hs, vertical, az * hs).normalize();
    h.q.rotateInv(this.ud, this.ub);
    const ub = this.ub;
    const errX = Math.atan2(ub.z, ub.y);
    const errZ = Math.atan2(-ub.x, ub.y);

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
