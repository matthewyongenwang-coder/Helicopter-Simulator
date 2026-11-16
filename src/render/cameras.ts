import * as THREE from 'three';
import type { Quat, Vec3 } from '../sim/math';
import type { Engine } from './engine';

export type CameraMode = 'chase' | 'cockpit' | 'orbit';

/**
 * The three views. Free look turns the view on top of any of them and springs
 * back when released; the spring starts from wherever the view is, so grabbing
 * it again mid-return never jumps.
 */
export class CameraRig {
  mode: CameraMode = 'chase';
  /** Camera position in world coordinates (doubles). */
  readonly world = { x: 0, y: 0, z: 0 };
  /** Free-look offset and its velocity, radians. */
  lookYaw = 0;
  lookPitch = 0;
  private vYaw = 0;
  private vPitch = 0;
  /** True while the player is steering the view. */
  looking = false;
  private orbit = 0;
  private snap = true;
  private shake = 0;
  private readonly q = new THREE.Quaternion();
  private readonly qLook = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly v = new THREE.Vector3();

  constructor(private engine: Engine, private ground: (x: number, z: number) => number) {}

  /** Jump straight to the target on the next update (after a spawn or a mode change). */
  reset(): void {
    this.snap = true;
    this.lookYaw = this.lookPitch = this.vYaw = this.vPitch = 0;
  }

  next(): CameraMode {
    this.mode = this.mode === 'chase' ? 'cockpit' : 'chase';
    this.reset();
    return this.mode;
  }

  /** Turn the view by a mouse movement, in pixels. */
  lookBy(dx: number, dy: number): void {
    this.lookYaw -= dx * 0.0042;
    this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - dy * 0.0042, -1.25, 1.25);
    this.vYaw = this.vPitch = 0;
  }

  update(dt: number, pos: Vec3, q: Quat, heading: number, rotorRadius: number, eye: THREE.Vector3, vibration: number, time: number): void {
    // Free look returns to centre on a critically damped spring once released.
    if (!this.looking) {
      const k = 60, c = 2 * Math.sqrt(k);
      this.vYaw += (-k * this.lookYaw - c * this.vYaw) * dt;
      this.vPitch += (-k * this.lookPitch - c * this.vPitch) * dt;
      this.lookYaw += this.vYaw * dt;
      this.lookPitch += this.vPitch * dt;
    }
    const cam = this.engine.camera;
    const w = this.world;
    this.shake += (vibration - this.shake) * Math.min(1, dt * 6);
    const sh = this.shake * 0.035;
    const sx = Math.sin(time * 61) * sh, sy = Math.sin(time * 47 + 1.3) * sh;

    if (this.mode === 'cockpit') {
      // Eye point in body axes, turned by the airframe, then by the pilot's head.
      this.q.set(q.x, q.y, q.z, q.w);
      this.v.copy(eye).applyQuaternion(this.q);
      w.x = pos.x + this.v.x;
      w.y = pos.y + this.v.y + sy;
      w.z = pos.z + this.v.z;
      this.qLook.setFromEuler(this.e.set(this.lookPitch, this.lookYaw, 0));
      cam.quaternion.copy(this.q).multiply(this.qLook);
      this.engine.toScene(w.x + sx, w.y, w.z, cam.position);
      if (cam.fov !== 72) {
        cam.fov = 72;
        cam.updateProjectionMatrix();
      }
      this.snap = false;
      return;
    }

    let dist: number, height: number, yaw: number, pitchUp = 0;
    if (this.mode === 'orbit') {
      this.orbit += dt * 0.11;
      dist = 7.5 + rotorRadius * 2.5;
      height = 2.2 + rotorRadius * 0.55;
      yaw = heading + 2.5 + this.orbit + this.lookYaw;
    } else {
      dist = 9 + rotorRadius * 1.7;
      height = 3 + rotorRadius * 0.45;
      yaw = heading + Math.PI + this.lookYaw; // behind the tail, turned by free look
      pitchUp = this.lookPitch;
    }
    // Swing the boom up or down with free-look pitch, keeping the same reach.
    const reach = Math.hypot(dist, height);
    const elev = THREE.MathUtils.clamp(Math.atan2(height, dist) - pitchUp, -0.2, 1.45);
    const horiz = Math.cos(elev) * reach;
    const tx = pos.x + Math.sin(yaw) * horiz;
    const tz = pos.z - Math.cos(yaw) * horiz;
    let ty = pos.y + Math.sin(elev) * reach;
    const floor = Math.max(0, this.ground(tx, tz)) + 1.2;
    if (ty < floor) ty = floor;
    if (this.snap || this.mode === 'orbit') {
      w.x = tx; w.y = ty; w.z = tz;
      this.snap = false;
    } else {
      const k = 1 - Math.exp(-dt * (this.looking ? 14 : 6));
      w.x += (tx - w.x) * k;
      w.y += (ty - w.y) * k;
      w.z += (tz - w.z) * k;
    }
    this.engine.toScene(w.x + sx, w.y + sy, w.z, cam.position);
    this.engine.toScene(pos.x, pos.y + 1.2, pos.z, this.v);
    cam.lookAt(this.v);
    if (cam.fov !== 62) {
      cam.fov = 62;
      cam.updateProjectionMatrix();
    }
  }
}
