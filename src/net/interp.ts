import type { PoseMsg } from './protocol';

/**
 * Smooths another pilot's aircraft between the pose updates that arrive about
 * 12 times a second. The aircraft is drawn a little in the past (see
 * INTERP_DELAY), between the two updates either side of that moment: position
 * follows a cubic through both updates using their velocities, rotation a
 * normalised blend. If updates stop, it coasts on its last velocity for a
 * moment and then holds still.
 */

export interface PoseSample {
  /** Local receive time, seconds. */
  t: number;
  /** Aircraft id. */
  a: string;
  /** x, y, z, qx, qy, qz, qw, vx, vy, vz. */
  s: number[];
  r: number;
  f: number;
}

/** Longest coast past the newest update, seconds. */
const MAX_EXTRAPOLATE = 0.3;
/** A jump this far from where the aircraft should be is a respawn: snap instead of sweeping across the map. */
const TELEPORT = 250;
const KEEP = 24;

export class PoseBuffer {
  private buf: PoseSample[] = [];

  get latest(): PoseSample | null {
    return this.buf[this.buf.length - 1] ?? null;
  }

  get size(): number {
    return this.buf.length;
  }

  push(t: number, m: PoseMsg): void {
    const last = this.latest;
    if (last) {
      const dt = Math.max(0, t - last.t);
      const s = last.s, n = m.s;
      const ex = s[0] + s[7] * dt - n[0], ey = s[1] + s[8] * dt - n[1], ez = s[2] + s[9] * dt - n[2];
      if (Math.hypot(ex, ey, ez) > TELEPORT || last.a !== m.a) this.buf.length = 0;
      // Two updates in one frame still need distinct times.
      else if (t <= last.t) t = last.t + 1e-3;
    }
    this.buf.push({ t, a: m.a, s: m.s.slice(), r: m.r, f: m.f });
    if (this.buf.length > KEEP) this.buf.splice(0, this.buf.length - KEEP);
  }

  clear(): void {
    this.buf.length = 0;
  }

  /**
   * Pose at local time `t`, written into `out` (10 numbers, as in PoseMsg.s).
   * Returns the update whose flags and rotor speed apply, or null with no data.
   */
  sample(t: number, out: number[]): PoseSample | null {
    const b = this.buf;
    if (b.length === 0) return null;
    if (t <= b[0].t) return this.coast(b[0], 0, out);
    const last = b[b.length - 1];
    if (t >= last.t) return this.coast(last, Math.min(MAX_EXTRAPOLATE, t - last.t), out);
    let i = 0;
    while (b[i + 1].t <= t) i++;
    // Updates older than the pair in use are no longer needed.
    if (i > 0) {
      b.splice(0, i);
      i = 0;
    }
    const p0 = b[0], p1 = b[1];
    const h = p1.t - p0.t;
    const u = (t - p0.t) / h;
    const a = p0.s, c = p1.s;
    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    for (let k = 0; k < 3; k++) out[k] = h00 * a[k] + h10 * h * a[7 + k] + h01 * c[k] + h11 * h * c[7 + k];
    // Shortest way round between the two rotations.
    const dot = a[3] * c[3] + a[4] * c[4] + a[5] * c[5] + a[6] * c[6];
    const sgn = dot < 0 ? -1 : 1;
    let len = 0;
    for (let k = 3; k < 7; k++) {
      out[k] = a[k] * (1 - u) + c[k] * sgn * u;
      len += out[k] * out[k];
    }
    len = Math.sqrt(len) || 1;
    for (let k = 3; k < 7; k++) out[k] /= len;
    for (let k = 7; k < 10; k++) out[k] = a[k] * (1 - u) + c[k] * u;
    return u < 0.5 ? p0 : p1;
  }

  private coast(p: PoseSample, dt: number, out: number[]): PoseSample {
    const s = p.s;
    for (let k = 0; k < 10; k++) out[k] = s[k];
    const len = Math.hypot(s[3], s[4], s[5], s[6]);
    if (len > 1e-6) for (let k = 3; k < 7; k++) out[k] /= len;
    else {
      out[3] = out[4] = out[5] = 0;
      out[6] = 1;
    }
    out[0] += s[7] * dt;
    out[1] += s[8] * dt;
    out[2] += s[9] * dt;
    return p;
  }
}
