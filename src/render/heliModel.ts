import * as THREE from 'three';
import type { AircraftData } from '../data/aircraft';

/** A built aircraft model with the moving parts exposed for animation. */
export interface HeliModel {
  root: THREE.Group;
  rotor: THREE.Group;
  tailRotor: THREE.Group;
  /** Translucent disc shown instead of individual blades at speed. */
  rotorBlur: THREE.Mesh;
  blades: THREE.Object3D;
  dispose(): void;
}

/**
 * Generic procedural helicopter sized from the aircraft data. Milestone 4
 * replaces this with a distinct model per aircraft.
 */
export function buildHeliModel(d: AircraftData): HeliModel {
  const root = new THREE.Group();
  const L = d.body.length, W = d.body.width, H = d.body.height;
  const R = d.rotor.diameter / 2;
  const hub = d.rotor.hubHeight;
  const gearY = Math.min(...d.gear.points.map((p) => p[1]));

  const paint = new THREE.MeshStandardMaterial({ color: 0x3d4a3a, roughness: 0.7, metalness: 0.15 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1d1f, roughness: 0.6, metalness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x11202a, roughness: 0.15, metalness: 0.6, transparent: true, opacity: 0.75 });
  const owned: { dispose(): void }[] = [paint, dark, glass];
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = root) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    owned.push(geo);
    return m;
  };

  // Cabin: an ellipsoid stretched along the nose–tail axis.
  const cabinLen = L * 0.46, cabinH = H * 0.5;
  const bodyY = gearY + 0.45 + cabinH / 2;
  const cabin = add(new THREE.SphereGeometry(0.5, 20, 14), paint, 0, bodyY, -L * 0.06);
  cabin.scale.set(W, cabinH, cabinLen);
  const nose = add(new THREE.SphereGeometry(0.5, 16, 12), glass, 0, bodyY + cabinH * 0.08, -L * 0.06 - cabinLen * 0.3);
  nose.scale.set(W * 0.86, cabinH * 0.8, cabinLen * 0.5);

  // Tail boom and fin.
  const boomLen = d.tail.arm - cabinLen * 0.25;
  const boom = add(new THREE.CylinderGeometry(W * 0.1, W * 0.26, boomLen, 10), paint, 0, bodyY + cabinH * 0.12, cabinLen * 0.25 + boomLen / 2 - L * 0.06);
  boom.rotation.x = Math.PI / 2;
  const fin = add(new THREE.BoxGeometry(0.12, H * 0.42, L * 0.07), paint, 0, bodyY + cabinH * 0.12 + H * 0.2, d.tail.arm - 0.2);
  fin.rotation.x = -0.35;
  add(new THREE.BoxGeometry(W * 0.9, 0.07, L * 0.045), paint, 0, bodyY + cabinH * 0.14, d.tail.arm - L * 0.09);

  // Mast, hub and blades.
  add(new THREE.CylinderGeometry(0.16, 0.22, hub - (bodyY + cabinH * 0.4), 8), dark, 0, (hub + bodyY + cabinH * 0.4) / 2, 0);
  const rotor = new THREE.Group();
  rotor.position.set(0, hub, 0);
  root.add(rotor);
  const blades = new THREE.Group();
  rotor.add(blades);
  add(new THREE.CylinderGeometry(0.3, 0.3, 0.22, 10), dark, 0, 0, 0, rotor);
  const bladeGeo = new THREE.BoxGeometry(d.rotor.chord, 0.05, R);
  owned.push(bladeGeo);
  for (let i = 0; i < d.rotor.blades; i++) {
    const arm = new THREE.Group();
    arm.rotation.y = (i / d.rotor.blades) * Math.PI * 2;
    const b = new THREE.Mesh(bladeGeo, dark);
    b.position.set(0, 0, -R / 2);
    b.castShadow = true;
    arm.add(b);
    blades.add(arm);
  }
  const blurMat = new THREE.MeshBasicMaterial({ color: 0x15171a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  owned.push(blurMat);
  const rotorBlur = add(new THREE.CircleGeometry(R, 48), blurMat, 0, 0.02, 0, rotor);
  rotorBlur.rotation.x = -Math.PI / 2;
  rotorBlur.castShadow = false;

  // Tail rotor.
  const tailRotor = new THREE.Group();
  tailRotor.position.set(W * 0.12 + 0.1, bodyY + cabinH * 0.12 + H * 0.22, d.tail.arm);
  root.add(tailRotor);
  const tr = R * 0.19;
  const trGeo = new THREE.BoxGeometry(0.04, tr * 2, 0.16);
  owned.push(trGeo);
  for (let i = 0; i < 2; i++) {
    const b = new THREE.Mesh(trGeo, dark);
    b.rotation.x = (i * Math.PI) / 2;
    tailRotor.add(b);
  }

  // Landing gear.
  if (d.gear.type === 'skids') {
    const zs = d.gear.points.map((p) => p[2]);
    const z0 = Math.min(...zs) - 0.5, z1 = Math.max(...zs) + 0.5;
    const x = Math.max(...d.gear.points.map((p) => Math.abs(p[0])));
    for (const side of [-1, 1]) {
      const skid = add(new THREE.CylinderGeometry(0.05, 0.05, z1 - z0, 8), dark, side * x, gearY + 0.05, (z0 + z1) / 2);
      skid.rotation.x = Math.PI / 2;
      for (const z of [z0 + 0.6, z1 - 0.6]) {
        const strut = add(new THREE.CylinderGeometry(0.035, 0.035, bodyY - gearY, 6), dark, side * x * 0.8, (bodyY + gearY) / 2, z);
        strut.rotation.z = side * 0.3;
      }
    }
  } else {
    for (const p of d.gear.points) {
      const wheel = add(new THREE.CylinderGeometry(0.3, 0.3, 0.22, 14), dark, p[0], p[1] + 0.3, p[2]);
      wheel.rotation.z = Math.PI / 2;
      add(new THREE.CylinderGeometry(0.05, 0.05, bodyY - p[1] - 0.3, 6), dark, p[0] * 0.85, (bodyY + p[1] + 0.3) / 2, p[2]);
    }
  }

  return {
    root,
    rotor,
    tailRotor,
    rotorBlur,
    blades,
    dispose() {
      for (const o of owned) o.dispose();
    },
  };
}
