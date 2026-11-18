import { TUNING } from '../data/tuning';
import { clamp, lerp, smoothstep } from './math';

const RT = TUNING.rotor;

/**
 * Induced velocity as a multiple of hover induced velocity, given climb speed
 * along the rotor axis (vc, + = rising) and in-plane speed (vt), both already
 * divided by hover induced velocity.
 *
 * Climb and forward flight use Glauert's momentum equation
 *   v · sqrt(vt² + (vc + v)²) = 1.
 * Axial descent uses Leishman's empirical fit through the vortex-ring region
 * and the windmill-brake momentum solution beyond it. The two are blended on vt.
 */
export function inflowRatio(vc: number, vt: number): number {
  if (vc >= 0) return glauert(vc, vt);
  const g = glauert(vc, vt);
  const w = smoothstep(0.3, 1.0, vt);
  if (w >= 1) return g;
  // Low forward speed: empirical axial curve, scaled so vc = 0 matches forward flight.
  let axial: number;
  if (vc >= -2) {
    const v2 = vc * vc;
    axial = 1 - 1.125 * vc - 1.372 * v2 - 1.718 * v2 * vc - 0.655 * v2 * v2;
  } else {
    axial = -vc / 2 - Math.sqrt(vc * vc / 4 - 1);
  }
  axial *= glauert(0, vt);
  return lerp(axial, g, w);
}

/** Smallest positive root of v²(vt² + (vc+v)²) = 1 by bisection + Newton polish. */
function glauert(vc: number, vt: number): number {
  const vt2 = vt * vt;
  let lo = 0, hi = 1;
  // f(hi) must be ≥ 0. For vc ≥ 0 that holds at 1; in descent expand.
  while (hi * hi * (vt2 + (vc + hi) * (vc + hi)) < 1 && hi < 64) hi *= 2;
  for (let i = 0; i < 22; i++) {
    const mid = 0.5 * (lo + hi);
    if (mid * mid * (vt2 + (vc + mid) * (vc + mid)) < 1) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * How deep the rotor is in vortex ring state (0–1), from the axial and in-plane
 * speeds normalised by hover induced velocity.
 */
export function vortexRingFactor(vcBar: number, vtBar: number): number {
  const V = TUNING.vortexRing;
  if (vcBar >= V.onsetStart) return 0;
  return (
    smoothstep(-V.onsetStart, -V.onsetFull, -vcBar) *
    (1 - smoothstep(-V.exitStart, -V.exitEnd, -vcBar)) *
    (1 - smoothstep(V.clearStart, V.clearEnd, vtBar))
  );
}

/** Soft blade-stall limit on the thrust coefficient. */
export function stallLimit(ct: number, ctMax: number): number {
  const knee = 0.8 * ctMax;
  if (ct > knee) return knee + (ctMax - knee) * Math.tanh((ct - knee) / (ctMax - knee));
  const neg = -0.35 * ctMax;
  if (ct < neg) return neg;
  return ct;
}

export interface RotorGeom {
  R: number;
  area: number;
  sigma: number;
  ctMax: number;
}

export interface RotorOut {
  thrust: number;
  /** Aerodynamic shaft power of the main rotor, W (negative when windmilling). */
  power: number;
  /** Target for the lagged induced-velocity state, m/s. */
  viTarget: number;
  hoverVi: number;
  mu: number;
  ctSigma: number;
  /** Climb / in-plane speed normalised by hover induced velocity. */
  vcBar: number;
  vtBar: number;
  vortexRing: number;
  groundFactor: number;
}

/** Ground-effect factor on induced velocity (Cheeseman–Bennett). */
export function groundFactor(R: number, hubAgl: number, vt: number, vi: number): number {
  const ratio = Math.min(TUNING.groundEffect.maxRatio, R / (4 * Math.max(hubAgl, 0.05)));
  const fwd = vt / Math.max(Math.abs(vi), 1);
  return 1 - (TUNING.groundEffect.strength * ratio * ratio) / (1 + fwd * fwd);
}

/**
 * Blade-element thrust and shaft power for the current flight state.
 * vc / vt are the air-relative velocity of the hub along and across the rotor axis.
 */
export function rotorAero(
  g: RotorGeom,
  theta: number,
  omega: number,
  rho: number,
  vc: number,
  vt: number,
  vi: number,
  hubAgl: number,
  out: RotorOut,
): RotorOut {
  const vTip = omega * g.R;
  if (vTip < 8) {
    out.thrust = 0; out.power = 0; out.viTarget = 0; out.hoverVi = 0; out.mu = 0; out.ctSigma = 0;
    out.vcBar = 0; out.vtBar = 0; out.vortexRing = 0; out.groundFactor = 1;
    return out;
  }
  const kG = groundFactor(g.R, hubAgl, vt, vi);
  const viEff = vi * kG;
  const mu = vt / vTip;
  const lambda = (vc + viEff) / vTip;
  const ctRaw = 0.5 * g.sigma * RT.liftSlope * ((theta / 3) * (1 + 1.5 * mu * mu) - lambda / 2);
  const ct = stallLimit(ctRaw, g.ctMax);
  const q = rho * g.area * vTip * vTip;
  let thrust = q * ct;

  // Hover-equivalent induced velocity for this thrust.
  const vh = Math.max(0.5, Math.sqrt(Math.abs(thrust) / (2 * rho * g.area)));
  const sign = thrust >= 0 ? 1 : -1;
  const vcBar = (sign * vc) / vh;
  const vtBar = vt / vh;

  // Vortex ring state: powered descent into the rotor's own wake.
  let vrs = 0;
  if (sign > 0 && thrust > 0) {
    // Reported for the blade-slap sound only: the ring no longer costs thrust.
    vrs = vortexRingFactor(vcBar, vtBar);
  }

  out.viTarget = sign * vh * inflowRatio(vcBar, vtBar);
  out.hoverVi = vh;

  const profile = (rho * g.area * vTip * vTip * vTip * g.sigma * RT.cd0 * (1 + 4.65 * mu * mu)) / 8;
  const induced = RT.kappa * thrust * viEff;
  const climb = thrust * vc;
  out.thrust = thrust;
  out.power = induced + climb + profile * (1 + 1.5 * vrs);
  out.mu = mu;
  out.ctSigma = ct / g.sigma;
  out.vcBar = vcBar;
  out.vtBar = vtBar;
  out.vortexRing = vrs;
  out.groundFactor = kG;
  return out;
}

/** Thrust at blade pitch theta in a steady out-of-ground-effect hover (closed form). */
export function hoverThrust(g: RotorGeom, theta: number, omega: number, rho: number): number {
  const sa = g.sigma * RT.liftSlope;
  // ct = (sa/2)(theta/3 − sqrt(ct/2)/2); solve for x = sqrt(ct/2).
  const b = sa / 4;
  const c = -(sa / 6) * theta;
  const x = (-b + Math.sqrt(b * b - 8 * c)) / 4;
  const ct = stallLimit(2 * x * x, g.ctMax);
  const vTip = omega * g.R;
  return rho * g.area * vTip * vTip * ct;
}

/**
 * Blade pitch that produces `thrust` once the inflow has settled, in the
 * current flight state. Inverse of rotorAero; used by autohover and derive.
 */
export function pitchForThrust(
  g: RotorGeom,
  thrust: number,
  omega: number,
  rho: number,
  vc: number,
  vt: number,
  hubAgl: number,
): number {
  const vTip = Math.max(omega * g.R, 30);
  const t = Math.max(thrust, 1);
  const vh = Math.max(0.5, Math.sqrt(t / (2 * rho * g.area)));
  let vi = vh * inflowRatio(vc / vh, vt / vh);
  vi *= groundFactor(g.R, hubAgl, vt, vi);
  const mu = vt / vTip;
  const ct = t / (rho * g.area * vTip * vTip);
  const lambda = (vc + vi) / vTip;
  return (3 * ((2 * ct) / (g.sigma * RT.liftSlope) + lambda / 2)) / (1 + 1.5 * mu * mu);
}

/** Total shaft power (main rotor + tail + accessories) from main-rotor aerodynamic power. */
export function shaftPower(mainPower: number, ratedPower: number): number {
  return mainPower + RT.tailPowerFraction * Math.max(mainPower, 0) + RT.accessoryFraction * ratedPower;
}

/**
 * Shaft power for steady level flight at true airspeed v. Used to size drag
 * from the listed top speed and to compute the menu performance figures.
 */
export function levelFlightPower(
  g: RotorGeom,
  tipSpeed: number,
  ratedPower: number,
  weight: number,
  fFwd: number,
  fVert: number,
  rho: number,
  v: number,
): number {
  // The nose-down tilt that balances drag also turns more of the fuselage into the wind.
  let alpha = 0, drag = 0;
  for (let i = 0; i < 4; i++) {
    const c = Math.cos(alpha), sn = Math.sin(alpha);
    drag = 0.5 * rho * v * v * (fFwd * c * c + fVert * sn * sn);
    alpha = Math.atan2(drag, weight);
  }
  const thrust = Math.hypot(weight, drag);
  const vc = v * Math.sin(alpha);
  const vt = v * Math.cos(alpha);
  const vh = Math.sqrt(thrust / (2 * rho * g.area));
  const vi = vh * inflowRatio(vc / vh, vt / vh);
  const mu = vt / tipSpeed;
  const profile = (rho * g.area * tipSpeed ** 3 * g.sigma * RT.cd0 * (1 + 4.65 * mu * mu)) / 8;
  return shaftPower(RT.kappa * thrust * vi + thrust * vc + profile, ratedPower);
}

export { clamp };
