/**
 * Minimal mutable vector / quaternion maths for the sim. No dependencies.
 *
 * Conventions used everywhere in src/sim:
 *   World: +X east, +Y up, +Z south. Heading 0 = north (−Z), 90° = east (+X).
 *   Body:  +X right, +Y up (rotor axis), −Z forward.
 *   Quaternions rotate body vectors into world space.
 */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const KTS = 0.514444; // m/s per knot
export const G = 9.80665;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
/** Wrap an angle to (−π, π]. */
export function wrapPi(a: number): number {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a <= 0) a += 2 * Math.PI;
  return a - Math.PI;
}
/** Exponential approach factor for a first-order lag with time constant tau over dt. */
export function lagAlpha(dt: number, tau: number): number {
  return tau <= 1e-6 ? 1 : 1 - Math.exp(-dt / tau);
}

export class Vec3 {
  constructor(public x = 0, public y = 0, public z = 0) {}
  set(x: number, y: number, z: number): this {
    this.x = x; this.y = y; this.z = z;
    return this;
  }
  copy(v: Vec3): this {
    this.x = v.x; this.y = v.y; this.z = v.z;
    return this;
  }
  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }
  add(v: Vec3): this {
    this.x += v.x; this.y += v.y; this.z += v.z;
    return this;
  }
  sub(v: Vec3): this {
    this.x -= v.x; this.y -= v.y; this.z -= v.z;
    return this;
  }
  scale(s: number): this {
    this.x *= s; this.y *= s; this.z *= s;
    return this;
  }
  addScaled(v: Vec3, s: number): this {
    this.x += v.x * s; this.y += v.y * s; this.z += v.z * s;
    return this;
  }
  dot(v: Vec3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
  /** this = a × b (safe when this aliases a or b). */
  cross(a: Vec3, b: Vec3): this {
    const x = a.y * b.z - a.z * b.y;
    const y = a.z * b.x - a.x * b.z;
    const z = a.x * b.y - a.y * b.x;
    this.x = x; this.y = y; this.z = z;
    return this;
  }
  len(): number {
    return Math.hypot(this.x, this.y, this.z);
  }
  lenSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }
  normalize(): this {
    const l = this.len();
    if (l > 1e-12) this.scale(1 / l);
    return this;
  }
}

export class Quat {
  constructor(public x = 0, public y = 0, public z = 0, public w = 1) {}
  copy(q: Quat): this {
    this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w;
    return this;
  }
  clone(): Quat {
    return new Quat(this.x, this.y, this.z, this.w);
  }
  normalize(): this {
    const l = Math.hypot(this.x, this.y, this.z, this.w) || 1;
    this.x /= l; this.y /= l; this.z /= l; this.w /= l;
    return this;
  }
  setAxisAngle(ax: number, ay: number, az: number, angle: number): this {
    const s = Math.sin(angle / 2);
    this.x = ax * s; this.y = ay * s; this.z = az * s; this.w = Math.cos(angle / 2);
    return this;
  }
  /** this = this ⊗ q */
  mul(q: Quat): this {
    const ax = this.x, ay = this.y, az = this.z, aw = this.w;
    this.x = aw * q.x + ax * q.w + ay * q.z - az * q.y;
    this.y = aw * q.y - ax * q.z + ay * q.w + az * q.x;
    this.z = aw * q.z + ax * q.y - ay * q.x + az * q.w;
    this.w = aw * q.w - ax * q.x - ay * q.y - az * q.z;
    return this;
  }
  /** Rotate v from body to world. out may alias v. */
  rotate(v: Vec3, out: Vec3): Vec3 {
    const { x, y, z, w } = this;
    const vx = v.x, vy = v.y, vz = v.z;
    const tx = 2 * (y * vz - z * vy);
    const ty = 2 * (z * vx - x * vz);
    const tz = 2 * (x * vy - y * vx);
    out.x = vx + w * tx + (y * tz - z * ty);
    out.y = vy + w * ty + (z * tx - x * tz);
    out.z = vz + w * tz + (x * ty - y * tx);
    return out;
  }
  /** Rotate v from world to body. out may alias v. */
  rotateInv(v: Vec3, out: Vec3): Vec3 {
    const x = -this.x, y = -this.y, z = -this.z, w = this.w;
    const vx = v.x, vy = v.y, vz = v.z;
    const tx = 2 * (y * vz - z * vy);
    const ty = 2 * (z * vx - x * vz);
    const tz = 2 * (x * vy - y * vx);
    out.x = vx + w * tx + (y * tz - z * ty);
    out.y = vy + w * ty + (z * tx - x * tz);
    out.z = vz + w * tz + (x * ty - y * tx);
    return out;
  }
  /** Integrate a body-frame angular velocity over dt. */
  integrateBody(wx: number, wy: number, wz: number, dt: number): this {
    const angle = Math.hypot(wx, wy, wz) * dt;
    if (angle < 1e-12) return this;
    const s = Math.sin(angle / 2) / (angle / dt);
    _dq.x = wx * s; _dq.y = wy * s; _dq.z = wz * s; _dq.w = Math.cos(angle / 2);
    return this.mul(_dq).normalize();
  }
  /**
   * Build from aviation angles (radians): heading clockwise from north,
   * pitch positive nose up, roll positive right side down.
   */
  setFromHPR(heading: number, pitch: number, roll: number): this {
    this.setAxisAngle(0, 1, 0, -heading);
    _dq.setAxisAngle(1, 0, 0, pitch);
    this.mul(_dq);
    _dq.setAxisAngle(0, 0, 1, -roll);
    return this.mul(_dq).normalize();
  }
}
const _dq = new Quat();

export interface Attitude {
  heading: number;
  pitch: number;
  roll: number;
}

const _f = new Vec3(), _r = new Vec3(), _u = new Vec3();
const FWD = new Vec3(0, 0, -1), RIGHT = new Vec3(1, 0, 0), UP = new Vec3(0, 1, 0);

/** Heading/pitch/roll (radians) from a body→world quaternion. */
export function attitudeOf(q: Quat, out: Attitude): Attitude {
  q.rotate(FWD, _f);
  q.rotate(RIGHT, _r);
  q.rotate(UP, _u);
  out.pitch = Math.asin(clamp(_f.y, -1, 1));
  out.heading = Math.atan2(_f.x, -_f.z);
  if (out.heading < 0) out.heading += 2 * Math.PI;
  out.roll = Math.atan2(-_r.y, _u.y);
  return out;
}

/** Deterministic 32-bit PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
