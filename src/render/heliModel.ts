import * as THREE from 'three';
import type { AircraftData } from '../data/aircraft';
import { AIRCRAFT_VISUAL, type Station } from '../data/aircraftVisual';

/** A built aircraft model with its moving parts exposed for animation. */
export interface HeliModel {
  root: THREE.Group;
  /** Everything except the cockpit frame. Hidden parts are chosen per camera. */
  exterior: THREE.Group;
  /** Fuselage shell, hidden from the cockpit camera so it does not block the view. */
  shell: THREE.Group;
  /** Glareshield and pillars, shown only from the cockpit camera. */
  cockpit: THREE.Group;
  rotor: THREE.Group;
  blades: THREE.Object3D;
  rotorBlur: THREE.Mesh;
  tailRotor: THREE.Group;
  tailBlades: THREE.Object3D;
  tailBlur: THREE.Mesh;
  /** Pilot eye point in body axes. */
  eye: THREE.Vector3;
  /** Emissive materials for the lights, so the game can flash them. */
  beacon: THREE.MeshBasicMaterial;
  navLights: THREE.MeshBasicMaterial[];
  landingLight: THREE.SpotLight;
  dispose(): void;
}

/**
 * Skin a fuselage through a list of cross-sections. Each section is a
 * superellipse, so one parameter takes the shape from round to slab-sided.
 * Vertex colours take the accent colour inside the optional band.
 */
function loft(stations: Station[], paint: THREE.Color, accent: THREE.Color, band: [number, number] | undefined, segs = 18): THREE.BufferGeometry {
  // Close both ends with a point.
  const first = stations[0], last = stations[stations.length - 1];
  const all: Station[] = [[first[0] - first[1] * 0.6, 0.001, 0.001, first[3], 2], ...stations, [last[0] + last[1] * 0.6, 0.001, 0.001, last[3], 2]];
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  for (const [z, w, h, y, p] of all) {
    const c = band && z >= band[0] && z <= band[1] ? accent : paint;
    for (let k = 0; k <= segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      const cs = Math.cos(a), sn = Math.sin(a);
      const e = 2 / p;
      pos.push(Math.sign(cs) * Math.pow(Math.abs(cs), e) * w, y + Math.sign(sn) * Math.pow(Math.abs(sn), e) * h, z);
      col.push(c.r, c.g, c.b);
    }
  }
  const ring = segs + 1;
  for (let i = 0; i < all.length - 1; i++) {
    for (let k = 0; k < segs; k++) {
      const a = i * ring + k, b = a + 1, c = a + ring, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Build the procedural model for one aircraft. */
export function buildHeliModel(d: AircraftData): HeliModel {
  const v = AIRCRAFT_VISUAL[d.id] ?? AIRCRAFT_VISUAL.medium;
  const root = new THREE.Group(), exterior = new THREE.Group(), shell = new THREE.Group(), cockpit = new THREE.Group();
  root.add(exterior, cockpit);
  exterior.add(shell);
  cockpit.visible = false;
  const R = d.rotor.diameter / 2, hub = d.rotor.hubHeight;
  const gearY = Math.min(...d.gear.points.map((p) => p[1]));
  const owned: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(o: T): T => {
    owned.push(o);
    return o;
  };

  const paintCol = new THREE.Color(v.paint), accentCol = new THREE.Color(v.accent);
  const body = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.2 }));
  const paint = keep(new THREE.MeshStandardMaterial({ color: v.paint, roughness: 0.62, metalness: 0.2 }));
  const accent = keep(new THREE.MeshStandardMaterial({ color: v.accent, roughness: 0.62, metalness: 0.2 }));
  const dark = keep(new THREE.MeshStandardMaterial({ color: 0x17191b, roughness: 0.55, metalness: 0.35 }));
  const glass = keep(new THREE.MeshStandardMaterial({ color: v.glass, roughness: 0.08, metalness: 0.7, transparent: true, opacity: 0.82 }));
  const interior = keep(new THREE.MeshStandardMaterial({ color: 0x101214, roughness: 0.9, metalness: 0 }));

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(keep(geo), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  const unitSphere = keep(new THREE.SphereGeometry(1, 20, 14));
  const blob = (b: number[], mat: THREE.Material, parent: THREE.Object3D) => {
    const m = new THREE.Mesh(unitSphere, mat);
    m.position.set(b[0], b[1], b[2]);
    m.scale.set(b[3], b[4], b[5]);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  const slab = (s: (number | undefined)[], mat: THREE.Material, parent: THREE.Object3D) => {
    const m = add(new THREE.BoxGeometry(s[3]!, s[4]!, s[5]!), mat, parent, s[0], s[1], s[2]);
    if (s[6]) m.rotation.x = s[6];
    return m;
  };

  // Fuselage, canopy glass, engine pods and fairings.
  add(loft(v.fuselage, paintCol, accentCol, v.band), body, shell);
  for (const g of v.glassParts) blob(g, glass, shell);
  for (const p of v.pods) blob(p, paint, shell);
  for (const s of v.slabs) slab(s, paint, shell);
  for (const s of v.darkSlabs) slab(s, dark, shell);

  // Tail boom, fin and stabiliser.
  const [bz0, by0, br0, bz1, by1, br1] = v.boom;
  const boomLen = Math.hypot(bz1 - bz0, by1 - by0);
  const boom = add(new THREE.CylinderGeometry(br1, br0, boomLen, 12), paint, exterior, 0, (by0 + by1) / 2, (bz0 + bz1) / 2);
  boom.rotation.x = Math.PI / 2 - Math.atan2(by1 - by0, bz1 - bz0);
  const [fz, fy, fh, fc, fs] = v.fin;
  const fin = add(new THREE.BoxGeometry(0.14, Math.hypot(fh, fs), fc), accent, exterior, 0, fy + fh / 2, fz + fs / 2);
  fin.rotation.x = -Math.atan2(fs, fh);
  const [sz, sy, sspan, sc] = v.stabiliser;
  add(new THREE.BoxGeometry(sspan, 0.08, sc), accent, exterior, 0, sy, sz);

  // Main rotor: mast, hub, blades with a little droop, and a blur disc for speed.
  add(new THREE.CylinderGeometry(0.13, 0.2, hub - v.mastBase + 0.1, 10), dark, exterior, 0, (hub + v.mastBase) / 2, 0);
  const rotor = new THREE.Group();
  rotor.position.set(0, hub, 0);
  exterior.add(rotor);
  const blades = new THREE.Group();
  rotor.add(blades);
  add(new THREE.CylinderGeometry(Math.max(0.22, R * 0.045), Math.max(0.22, R * 0.045), 0.2, 12), dark, rotor);
  const bladeGeo = keep(new THREE.BoxGeometry(d.rotor.chord, 0.045, R * 0.95));
  const bladeMat = keep(new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.7, metalness: 0.1 }));
  for (let i = 0; i < d.rotor.blades; i++) {
    const arm = new THREE.Group();
    arm.rotation.y = (i / d.rotor.blades) * Math.PI * 2;
    const b = new THREE.Mesh(bladeGeo, bladeMat);
    b.position.set(0, 0, -R * 0.525);
    b.castShadow = true;
    const tilt = new THREE.Group();
    tilt.rotation.x = -v.droop;
    tilt.add(b);
    arm.add(tilt);
    blades.add(arm);
  }
  if (v.flybar) add(new THREE.BoxGeometry(R * 0.5, 0.05, 0.06), dark, blades, 0, 0.28, 0);
  const blurMat = keep(new THREE.MeshBasicMaterial({ color: 0x1a1c1e, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  const rotorBlur = add(new THREE.RingGeometry(R * 0.06, R, 56), blurMat, rotor, 0, 0.03, 0);
  rotorBlur.rotation.x = -Math.PI / 2;
  rotorBlur.castShadow = false;

  // Tail rotor.
  const [tSide, tR, tBlades, tUp] = v.tailRotor;
  const tailRotor = new THREE.Group();
  tailRotor.position.set(tSide * (br1 + 0.22), by1 + tUp, bz1 + 0.05);
  exterior.add(tailRotor);
  const tailBlades = new THREE.Group();
  tailRotor.add(tailBlades);
  const tGeo = keep(new THREE.BoxGeometry(0.035, tR * 2, tR * 0.2));
  for (let i = 0; i < tBlades / 2; i++) {
    const b = new THREE.Mesh(tGeo, bladeMat);
    b.rotation.x = (i / (tBlades / 2)) * Math.PI;
    b.castShadow = true;
    tailBlades.add(b);
  }
  const tailBlurMat = keep(blurMat.clone());
  const tailBlur = add(new THREE.CircleGeometry(tR, 28), tailBlurMat, tailRotor);
  tailBlur.rotation.y = Math.PI / 2;
  tailBlur.castShadow = false;

  // Landing gear.
  const bellyY = v.fuselage.reduce((m, s) => Math.min(m, s[3] - s[2]), Infinity);
  if (d.gear.type === 'skids') {
    const zs = d.gear.points.map((p) => p[2]);
    const z0 = Math.min(...zs) - 0.55, z1 = Math.max(...zs) + 0.45;
    const x = Math.max(...d.gear.points.map((p) => Math.abs(p[0])));
    for (const side of [-1, 1]) {
      const skid = add(new THREE.CylinderGeometry(0.045, 0.045, z1 - z0, 8), dark, exterior, side * x, gearY + 0.045, (z0 + z1) / 2);
      skid.rotation.x = Math.PI / 2;
      const toe = add(new THREE.CylinderGeometry(0.045, 0.045, 0.5, 8), dark, exterior, side * x, gearY + 0.15, z0 - 0.18);
      toe.rotation.x = Math.PI / 2 - 0.5;
      for (const z of [zs[0] + 0.1, zs[zs.length - 1] - 0.1]) {
        const len = Math.hypot(bellyY + 0.25 - gearY, x * 0.45);
        const strut = add(new THREE.CylinderGeometry(0.035, 0.035, len, 6), dark, exterior, side * x * 0.78, (bellyY + 0.25 + gearY) / 2, z);
        strut.rotation.z = side * Math.atan2(x * 0.45, bellyY + 0.25 - gearY);
      }
    }
  } else {
    const wr = v.wheelRadius;
    for (const p of d.gear.points) {
      const small = Math.abs(p[0]) < 0.01 && d.gear.points.length === 3;
      const r = small ? wr * 0.75 : wr;
      const wheel = add(new THREE.CylinderGeometry(r, r, r * 0.7, 16), dark, exterior, p[0], p[1] + r, p[2]);
      wheel.rotation.z = Math.PI / 2;
      // Strut up into the nearest part of the airframe.
      const topY = Math.max(bellyY + 0.3, p[1] + r + 0.3);
      const inX = p[0] * 0.7;
      const len = Math.hypot(topY - (p[1] + r), p[0] - inX);
      const strut = add(new THREE.CylinderGeometry(0.06, 0.06, len, 6), dark, exterior, (p[0] + inX) / 2, (topY + p[1] + r) / 2, p[2]);
      strut.rotation.z = Math.atan2(p[0] - inX, topY - (p[1] + r));
    }
  }

  // Lights: red left, green right, white tail, red beacon on top; a landing light under the nose.
  const widest = v.fuselage.reduce((m, s) => (s[1] > m[1] ? s : m));
  const lightGeo = keep(new THREE.SphereGeometry(0.07, 8, 6));
  const mkLight = (color: number, x: number, y: number, z: number) => {
    const mat = keep(new THREE.MeshBasicMaterial({ color }));
    const m = new THREE.Mesh(lightGeo, mat);
    m.position.set(x, y, z);
    exterior.add(m);
    return mat;
  };
  const navLights = [
    mkLight(0xff2a1a, -widest[1] - 0.04, widest[3], widest[0]),
    mkLight(0x1aff4a, widest[1] + 0.04, widest[3], widest[0]),
    mkLight(0xffffff, 0, by1 + 0.1, bz1 + 0.25),
  ];
  const beacon = mkLight(0xff2010, 0, fy + fh + 0.12, fz + fs);
  const nose = v.fuselage[1];
  const landingLight = new THREE.SpotLight(0xfff2d8, 0, 260, 0.5, 0.55, 1.2);
  landingLight.position.set(0, nose[3] - nose[2], nose[0]);
  landingLight.target.position.set(0, nose[3] - nose[2] - 22, nose[0] - 26);
  exterior.add(landingLight, landingLight.target);

  // Cockpit frame, seen from the pilot's eye: glareshield, panel, windscreen pillars, roof beam.
  const eye = new THREE.Vector3(...v.eye);
  const c = v.cockpit;
  const frame = (sx: number, sy: number, sz2: number, x: number, y: number, z: number, rx = 0, rz = 0) => {
    const m = add(new THREE.BoxGeometry(sx, sy, sz2), interior, cockpit, eye.x + x, eye.y + y, eye.z + z);
    m.rotation.set(rx, 0, rz);
    m.castShadow = false;
    return m;
  };
  const shieldY = c.shield - eye.y;
  frame(c.pillar * 2.6, 0.05, 0.5, -eye.x, shieldY - 0.02, -c.reach + 0.1, 0.12);
  frame(c.pillar * 2.4, 0.42, 0.06, -eye.x, shieldY - 0.24, -c.reach + 0.32);
  for (const side of [-1, 1]) {
    frame(0.07, 1.25, 0.07, -eye.x + side * c.pillar, shieldY + 0.5, -c.reach - 0.18, -0.42, side * -0.08);
    frame(0.06, 0.05, 1.1, -eye.x + side * (c.pillar + 0.05), shieldY - 0.08, -c.reach + 0.75);
  }
  frame(c.pillar * 2.3, 0.07, 0.09, -eye.x, c.roof - eye.y + 0.15, -c.reach + 0.28);
  if (c.pillar > 0.7) frame(0.06, 1.1, 0.06, -eye.x, shieldY + 0.5, -c.reach - 0.2, -0.42);

  return {
    root, exterior, shell, cockpit, rotor, blades, rotorBlur, tailRotor, tailBlades, tailBlur, eye, beacon, navLights, landingLight,
    dispose() {
      for (const o of owned) o.dispose();
      landingLight.dispose();
    },
  };
}
