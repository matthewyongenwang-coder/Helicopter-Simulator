import * as THREE from 'three';
import { SUPPLY } from '../data/weapons';
import type { Resupply } from '../game/resupply';
import { localToWorld } from '../world/compounds';
import type { SupplySite } from '../world/supply';
import type { Engine } from './engine';
import { merge, paint } from './ordnance';

/**
 * What a supply point looks like: a painted apron draped over the field, a
 * ring of ammunition crates, fuel bladders and a crew tent, and a mast whose
 * green beacon blinks so it can be picked out from a distance.
 */

const C = {
  crate: 0x5c5a36,
  crateLight: 0x7a7046,
  ammo: 0x40492e,
  bladder: 0x1f2320,
  tent: 0x6b6f4c,
  metal: 0x5c6064,
  pallet: 0x8a6a45,
  sock: 0xff7a1a,
};

const box = (w: number, h: number, d: number, x: number, y: number, z: number, col: number, ry = 0) =>
  paint(new THREE.BoxGeometry(w, h, d).rotateY(ry).translate(x, y + h / 2, z), col);

/** Apron marking: a light pad, a green ring, a white-edged green cross. Transparent outside the disc. */
function apronTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 256, 256);
  g.fillStyle = '#7d7a70';
  g.beginPath();
  g.arc(128, 128, 126, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#3fcf62';
  g.lineWidth = 12;
  g.beginPath();
  g.arc(128, 128, 112, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#f2f2ee';
  g.fillRect(110, 52, 36, 152);
  g.fillRect(52, 110, 152, 36);
  g.fillStyle = '#3fcf62';
  g.fillRect(116, 58, 24, 140);
  g.fillRect(58, 116, 140, 24);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

interface SiteView {
  site: SupplySite;
  group: THREE.Group;
  apron: THREE.Mesh;
  props: THREE.Mesh;
}

export class SupplyView {
  private views = new Map<string, SiteView>();
  private apronMat = new THREE.MeshStandardMaterial({ map: apronTexture(), transparent: true, alphaTest: 0.5, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  private propMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 });
  private beaconMat = new THREE.MeshBasicMaterial({ color: 0x30ff60, toneMapped: false, fog: false });
  private beaconGeo = new THREE.SphereGeometry(0.45, 12, 8);
  private time = 0;

  constructor(private engine: Engine, private supply: Resupply, private ground: (x: number, z: number) => number) {}

  update(dt: number, camX: number, camZ: number): void {
    this.time += dt;
    const o = this.engine.origin;
    for (const s of this.supply.sites) {
      if (!s.field || this.views.has(s.id)) continue;
      if (Math.hypot(s.x - camX, s.z - camZ) < SUPPLY.viewRange) this.views.set(s.id, this.build(s));
    }
    for (const [id, v] of this.views) {
      const s = v.site;
      if (Math.hypot(s.x - camX, s.z - camZ) > SUPPLY.viewRange + 1000) {
        this.engine.scene.remove(v.group);
        v.apron.geometry.dispose();
        v.props.geometry.dispose();
        this.views.delete(id);
        continue;
      }
      v.group.position.set(s.x - o.x, 0, s.z - o.z);
    }
    // A short bright flash every 1.2 s, a dim glow between.
    const on = this.time % 1.2 < 0.18;
    this.beaconMat.color.setRGB(on ? 0.5 : 0.04, on ? 4 : 0.35, on ? 1 : 0.08);
  }

  private build(s: SupplySite): SiteView {
    const group = new THREE.Group();
    const apron = new THREE.Mesh(this.drape(s), this.apronMat);
    apron.receiveShadow = true;
    group.add(apron);

    // Outside the landing zone: crate stacks, fuel bladders, a tent, a windsock and the beacon mast.
    const g: THREE.BufferGeometry[] = [];
    const at = (angle: number, r: number) => {
      const [x, z] = localToWorld(0, 0, s.yaw, Math.sin(angle) * r, Math.cos(angle) * r);
      return { x, z, y: this.ground(s.x + x, s.z + z) - 0.05 };
    };
    const R = SUPPLY.propRing;
    for (const a of [0.2, 0.55, 2.4, 4.1]) {
      const p = at(a, R + (a > 2 ? 2 : 0));
      const ry = s.yaw + a;
      g.push(box(3.2, 0.25, 2.4, p.x, p.y, p.z, C.pallet, ry));
      for (const [dx, dz] of [[-0.8, -0.55], [0.8, -0.55], [-0.8, 0.55], [0.8, 0.55]]) {
        const [ox, oz] = localToWorld(p.x, p.z, ry, dx, dz);
        g.push(box(1.45, 0.9, 1.0, ox, p.y + 0.25, oz, dx + dz > 0 ? C.crate : C.ammo, ry));
      }
      g.push(box(1.5, 0.8, 1.9, p.x, p.y + 1.15, p.z, C.crateLight, ry));
    }
    for (const a of [1.2, 1.55]) {
      const p = at(a, R + 3);
      g.push(paint(new THREE.SphereGeometry(1, 16, 8).scale(3.4, 0.75, 2.2).rotateY(s.yaw + a).translate(p.x, p.y + 0.55, p.z), C.bladder));
    }
    {
      const p = at(3.2, R + 4);
      // A ridge tent: a three-sided prism lying on one face.
      const tent = new THREE.CylinderGeometry(2.4, 2.4, 6, 3, 1).rotateZ(Math.PI / 2).rotateX(Math.PI / 6);
      g.push(paint(tent.rotateY(s.yaw + 3.2).translate(p.x, p.y + 1.2, p.z), C.tent));
    }
    {
      const p = at(5.2, R + 1);
      g.push(paint(new THREE.CylinderGeometry(0.09, 0.12, 7, 6).translate(p.x, p.y + 3.5, p.z), C.metal));
      g.push(paint(new THREE.CylinderGeometry(0.35, 0.15, 2.2, 8, 1, true).rotateZ(Math.PI / 2).translate(p.x + 1.1, p.y + 6.6, p.z), C.sock));
    }
    const mast = at(5.9, R);
    g.push(paint(new THREE.CylinderGeometry(0.12, 0.18, 10, 6).translate(mast.x, mast.y + 5, mast.z), C.metal));
    const props = new THREE.Mesh(merge(g), this.propMat);
    props.castShadow = props.receiveShadow = true;
    group.add(props);
    const beacon = new THREE.Mesh(this.beaconGeo, this.beaconMat);
    beacon.position.set(mast.x, mast.y + 10.3, mast.z);
    group.add(beacon);

    this.engine.scene.add(group);
    return { site: s, group, apron, props };
  }

  /** A square grid over the apron, following the ground, textured with the disc. */
  private drape(s: SupplySite): THREE.BufferGeometry {
    const A = SUPPLY.apron, n = 24;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const lx = -A + (2 * A * i) / n, lz = -A + (2 * A * j) / n;
        const [x, z] = localToWorld(0, 0, s.yaw, lx, lz);
        pos.push(x, this.ground(s.x + x, s.z + z) + 0.06, z);
        uv.push(i / n, 1 - j / n);
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }
}
