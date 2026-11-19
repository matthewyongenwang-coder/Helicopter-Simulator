import * as THREE from 'three';
import { AIRCRAFT } from '../data/aircraft';
import type { Engine } from './engine';
import { buildHeliModel, type HeliModel } from './heliModel';

/** What the renderer needs to draw another pilot's aircraft this frame. */
export interface RemotePose {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  /** Rotor speed as a fraction of 100 %. */
  rotorN: number;
  powered: boolean;
  destroyed: boolean;
  rotorOk: boolean;
  tailRotorOk: boolean;
}

const NAV_COLORS = [0xff2a1a, 0x1aff4a, 0xffffff];

/**
 * Another pilot's aircraft: the same procedural model as your own, posed from
 * the network, with spinning rotors, nav lights and a beacon. Its landing
 * light is left out, because every extra light in the scene makes every
 * material recompile and costs fill rate.
 */
export class RemoteAircraft {
  model: HeliModel;
  aircraftId: string;
  private angle = 0;
  private charred = false;

  constructor(private engine: Engine, aircraftId: string) {
    // The id comes from the network: own keys only, so "toString" cannot reach buildHeliModel.
    this.aircraftId = Object.hasOwn(AIRCRAFT, aircraftId) ? aircraftId : 'medium';
    this.model = this.build(this.aircraftId);
  }

  private build(id: string): HeliModel {
    const m = buildHeliModel(AIRCRAFT[id]);
    m.landingLight.target?.removeFromParent();
    m.landingLight.removeFromParent();
    m.cockpit.visible = false;
    this.engine.scene.add(m.root);
    this.charred = false;
    return m;
  }

  /** Swap the model when the pilot changes aircraft. */
  setAircraft(id: string): void {
    if (id === this.aircraftId || !Object.hasOwn(AIRCRAFT, id)) return;
    this.dispose();
    this.aircraftId = id;
    this.model = this.build(id);
  }

  update(dt: number, p: RemotePose, daylight: number, time: number): void {
    const m = this.model, d = AIRCRAFT[this.aircraftId];
    this.engine.toScene(p.x, p.y, p.z, m.root.position);
    m.root.quaternion.set(p.qx, p.qy, p.qz, p.qw);
    const n = p.rotorN;
    this.angle = (this.angle + n * (d.rotor.tipSpeed / (d.rotor.diameter / 2)) * dt) % (Math.PI * 2);
    m.blades.rotation.y = this.angle;
    m.tailBlades.rotation.x = this.angle * 4.7;
    const blur = THREE.MathUtils.smoothstep(n, 0.3, 0.8);
    (m.rotorBlur.material as THREE.MeshBasicMaterial).opacity = (p.rotorOk ? 0.42 : 0) * blur;
    (m.tailBlur.material as THREE.MeshBasicMaterial).opacity = (p.tailRotorOk ? 0.2 : 0) * blur;
    m.blades.visible = n < 0.9 && p.rotorOk;
    m.tailBlades.visible = n < 0.9 && p.tailRotorOk;
    const spin = THREE.MathUtils.smoothstep(n, 0.15, 0.75);
    for (const tilt of m.bladeTilts) tilt.rotation.x = -m.droop * (1 - spin) + 0.04 * spin;
    const level = p.powered ? 0.7 + 1.6 * (1 - daylight) : 0.05;
    m.navLights.forEach((l, i) => l.color.setHex(NAV_COLORS[i]).multiplyScalar(level));
    m.beacon.color.setHex(0xff2010).multiplyScalar(p.powered && time % 1.1 < 0.12 ? 4 : 0.05);
    if (p.destroyed && !this.charred) {
      this.charred = true;
      for (const mat of m.materials) {
        mat.color.multiplyScalar(0.16);
        mat.roughness = 1;
        mat.metalness = 0;
      }
    }
  }

  set visible(v: boolean) {
    this.model.root.visible = v;
  }

  dispose(): void {
    this.engine.scene.remove(this.model.root);
    this.model.dispose();
  }
}
