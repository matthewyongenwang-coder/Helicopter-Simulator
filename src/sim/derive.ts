import type { AircraftData } from '../data/aircraft';
import { TUNING } from '../data/tuning';
import { DEG, G, KTS } from './math';
import { hoverThrust, levelFlightPower, pitchForThrust, shaftPower, type RotorGeom } from './rotor';
import type { Aircraft } from './types';

const RT = TUNING.rotor;
const RHO0: number = TUNING.atmosphere.rho0;

function bisect(f: (x: number) => number, lo: number, hi: number, iters = 48): number {
  let flo = f(lo);
  for (let i = 0; i < iters; i++) {
    const mid = 0.5 * (lo + hi);
    const fm = f(mid);
    if ((fm < 0) === (flo < 0)) {
      lo = mid;
      flo = fm;
    } else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Static load on each gear point for a level aircraft (minimum-norm solution). */
function staticLoads(points: [number, number, number][], weight: number): number[] {
  // Minimise Σl² subject to Σl = W, Σl·x = 0, Σl·z = 0  →  l = Aᵀ (A Aᵀ)⁻¹ b.
  let s1 = 0, sx = 0, sz = 0, sxx = 0, szz = 0, sxz = 0;
  for (const [x, , z] of points) {
    s1 += 1; sx += x; sz += z; sxx += x * x; szz += z * z; sxz += x * z;
  }
  const m = [
    [s1, sx, sz],
    [sx, sxx, sxz],
    [sz, sxz, szz],
  ];
  const det =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (Math.abs(det) < 1e-9) return points.map(() => weight / points.length);
  // First column of the inverse times W (b = [W, 0, 0]).
  const y0 = ((m[1][1] * m[2][2] - m[1][2] * m[2][1]) / det) * weight;
  const y1 = (-(m[1][0] * m[2][2] - m[1][2] * m[2][0]) / det) * weight;
  const y2 = ((m[1][0] * m[2][1] - m[1][1] * m[2][0]) / det) * weight;
  return points.map(([x, , z]) => Math.max(0.02 * weight, y0 + y1 * x + y2 * z));
}

const cache = new Map<string, Aircraft>();

/** Turn a data entry into the coefficient set the physics runs on. Cached per id. */
export function deriveAircraft(d: AircraftData): Aircraft {
  const hit = cache.get(d.id);
  if (hit && hit.data === d) return hit;

  const R = d.rotor.diameter / 2;
  const area = Math.PI * R * R;
  const sigma = (d.rotor.blades * d.rotor.chord) / (Math.PI * R);
  const ctMax = RT.ctSigmaMax * sigma;
  const geom: RotorGeom = { R, area, sigma, ctMax };
  const omega0 = d.rotor.tipSpeed / R;
  const bladeMass = RT.bladeArealDensity * d.rotor.chord * R;
  const rotorInertia = (d.rotor.blades * bladeMass * R * R) / 3;

  const powerMax = d.engine.powerKW * 1000;
  const torqueRated = powerMax / omega0;
  const stdMass = d.mass.empty + d.mass.crew + d.mass.payloadStd + d.fuel.capacity;
  const stdWeight = stdMass * G;

  // Blade pitch range.
  const wantMax = RT.maxThrustOverMTOW * d.mass.maxTakeoff * G;
  const stallMax = RHO0 * area * d.rotor.tipSpeed ** 2 * ctMax;
  const thetaMax = bisect((th) => hoverThrust(geom, th, omega0, RHO0) - Math.min(wantMax, 0.97 * stallMax), 0.02, 0.6);
  const lightWeight = (d.mass.empty + d.mass.crew + 0.2 * d.fuel.capacity) * G;
  const ctLight = lightWeight / (RHO0 * area * d.rotor.tipSpeed ** 2);
  const thetaAuto = (6 * ctLight) / (sigma * RT.liftSlope) - 0.45 * Math.sqrt(ctLight / 2);
  const thetaMin = Math.max(0.004, RT.thetaMinFraction * thetaAuto);
  const leverFor = (theta: number) => (theta - thetaMin) / (thetaMax - thetaMin);
  const hoverCollective = leverFor(pitchForThrust(geom, stdWeight, omega0, RHO0, 0, 0, 1e6));

  // Start-sequence torque: enough to spin the rotor up at flat pitch, never enough to
  // lift the lightest aircraft with the lever fully raised (ground effect included).
  const tFull = hoverThrust(geom, thetaMax, omega0, RHO0);
  const pFull = shaftPower(
    RT.kappa * tFull * Math.sqrt(tFull / (2 * RHO0 * area)) + (RHO0 * area * d.rotor.tipSpeed ** 3 * sigma * RT.cd0) / 8,
    powerMax,
  );
  const minWeight = (d.mass.empty + d.mass.crew) * G;
  const groundBoost = 1 - TUNING.groundEffect.maxRatio ** 2;
  const noLiftFraction = ((pFull / powerMax) / (tFull / minWeight)) * groundBoost;
  const startTorque = torqueRated * Math.min(TUNING.engine.startTorqueFraction, Math.max(0.22, 0.8 * noLiftFraction));

  // Forward drag area from the listed top speed at rated power.
  const topSpeed = d.perf.topSpeedKts * KTS;
  const vne = d.perf.vneKts * KTS;
  const fFwd = bisect(
    (f) => levelFlightPower(geom, d.rotor.tipSpeed, powerMax, stdWeight, f, f * d.body.vertDrag, RHO0, topSpeed) - powerMax,
    0.02,
    40,
  );

  // Inertia.
  const kLong = d.body.gyration * d.body.length;
  const kRoll = 0.33 * 0.5 * (d.body.width + d.body.height);
  const Ixx = stdMass * kLong * kLong;
  const Iyy = stdMass * kLong * kLong * 1.05;
  const Izz = stdMass * kRoll * kRoll;

  // Yaw.
  const yawRate = d.handling.yawRate * DEG;
  const kr = Iyy / d.handling.yawTau;
  const tailTorqueMax = TUNING.yaw.authorityMargin * (torqueRated * TUNING.engine.torqueLimit + kr * yawRate);
  const hoverTorqueAt = (c: number): number => {
    const t = hoverThrust(geom, thetaMin + c * (thetaMax - thetaMin), omega0, RHO0);
    const vh = Math.sqrt(Math.max(t, 0) / (2 * RHO0 * area));
    const profile = (RHO0 * area * d.rotor.tipSpeed ** 3 * sigma * RT.cd0) / 8;
    return shaftPower(RT.kappa * t * vh + profile, powerMax) / omega0;
  };
  const pedalNeeded = (c: number) => hoverTorqueAt(c) / (tailTorqueMax * d.tail.lowSpeedAuthority);
  const pedalHover = pedalNeeded(hoverCollective);
  const pedalSlope = (d.tail.interlink * (pedalNeeded(hoverCollective + 0.02) - pedalNeeded(hoverCollective - 0.02))) / 0.04;

  // Landing gear.
  const loads = staticLoads(d.gear.points, stdWeight);
  const defl = TUNING.gear.staticDeflection * d.gear.stroke;
  const gearK = loads.map((l) => l / defl);
  const gearC = loads.map((l, i) => 2 * TUNING.gear.dampingRatio * Math.sqrt(gearK[i] * (l / G)));
  let restHeight = 0;
  for (let i = 0; i < loads.length; i++) restHeight += (-d.gear.points[i][1] * loads[i]) / stdWeight;
  restHeight -= defl;

  const rotorTips: [number, number, number][] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    rotorTips.push([Math.sin(a) * R * 0.97, d.rotor.hubHeight, Math.cos(a) * R * 0.97]);
  }

  // Menu figures from the same model.
  const pLevel = (v: number, rho = RHO0) =>
    levelFlightPower(geom, d.rotor.tipSpeed, powerMax, stdWeight, fFwd, fFwd * d.body.vertDrag, rho, v);
  const hoverPower = pLevel(0);
  let maxClimb = 0, bestClimbSpeed = 0;
  for (let v = 0; v <= topSpeed; v += 1) {
    const climb = (0.88 * (powerMax - pLevel(v))) / stdWeight;
    if (climb > maxClimb) {
      maxClimb = climb;
      bestClimbSpeed = v;
    }
  }
  const pAvail = (h: number) => powerMax * Math.exp((-h / TUNING.atmosphere.scaleHeight) * TUNING.atmosphere.powerLapse);
  const rhoAt = (h: number) => RHO0 * Math.exp(-h / TUNING.atmosphere.scaleHeight);
  const hoverCeiling =
    pLevel(0, rhoAt(0)) >= pAvail(0) ? 0 : bisect((h) => pLevel(0, rhoAt(h)) - pAvail(h), 0, 9000);
  let cruiseSpeed = topSpeed * 0.85;
  if (pLevel(cruiseSpeed) > 0.78 * powerMax) cruiseSpeed = bisect((v) => pLevel(v) - 0.78 * powerMax, bestClimbSpeed, topSpeed);
  const burnRated = d.fuel.burnRated / 3600;
  const cruiseBurn = burnRated * (d.fuel.idleFraction + (1 - d.fuel.idleFraction) * (pLevel(cruiseSpeed) / powerMax));
  const endurance = d.fuel.capacity / cruiseBurn / 3600;

  const ac: Aircraft = {
    data: d,
    R, area, sigma, omega0, rotorInertia, thetaMin, thetaMax, ctMax,
    powerMax, torqueRated, startTorque, burnRated,
    stdMass,
    fFwd,
    fSide: fFwd * d.body.sideDrag,
    fVert: fFwd * d.body.vertDrag,
    finArea: fFwd * TUNING.yaw.finFactor,
    Ixx, Iyy, Izz,
    pitchRate: d.handling.pitchRate * DEG,
    rollRate: d.handling.rollRate * DEG,
    yawRate,
    tailTorqueMax, pedalHover, pedalSlope, hoverCollective,
    topSpeed, vne,
    gearK, gearC, rotorTips, restHeight,
    ahMaxTilt: d.autohover.maxTilt * DEG,
    ahMaxRate: d.autohover.maxRate * DEG,
    computed: {
      hoverPowerFraction: hoverPower / powerMax,
      maxClimb,
      bestClimbSpeed,
      hoverCeiling,
      endurance,
      range: (cruiseSpeed * endurance * 3600) / 1000,
      cruiseSpeed,
      powerToWeight: d.engine.powerKW / stdMass,
      diskLoading: stdMass / area,
    },
  };
  cache.set(d.id, ac);
  return ac;
}
