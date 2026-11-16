import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Paint a whole geometry one vertex colour (sRGB values). */
function tint(geo: THREE.BufferGeometry, r: number, g: number, b: number): THREE.BufferGeometry {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  const col = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
  for (let i = 0; i < n; i++) {
    c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  for (const p of flat) p.deleteAttribute('uv');
  const out = mergeGeometries(flat, false)!;
  for (const p of parts) p.dispose();
  return out;
}

/** Unit box sitting on y = 0: buildings scale it by (width, height, depth). */
export function boxGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
}

/** Unit box centred on the origin, for slabs and piers. */
export function slabGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1, 1, 1);
}

/**
 * A house: unit walls (y 0–1) with a gable roof above. The `part` attribute is 0
 * on walls and 1 on the roof so the shader can colour them separately.
 */
export function houseGeometry(): THREE.BufferGeometry {
  const roof = 0.62; // roof height as a fraction of wall height
  const e = 0.56; // eave overhang half-width
  const P: number[] = [], N: number[] = [], part: number[] = [];
  const tri = (a: number[], b: number[], c: number[], p: number) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    for (const v of [a, b, c]) {
      P.push(v[0], v[1], v[2]);
      N.push(nx / l, ny / l, nz / l);
      part.push(p);
    }
  };
  const quad = (a: number[], b: number[], c: number[], d: number[], p: number) => {
    tri(a, b, c, p);
    tri(a, c, d, p);
  };
  const x = 0.5, z = 0.5;
  // Walls.
  quad([-x, 0, z], [x, 0, z], [x, 1, z], [-x, 1, z], 0);
  quad([x, 0, -z], [-x, 0, -z], [-x, 1, -z], [x, 1, -z], 0);
  quad([x, 0, z], [x, 0, -z], [x, 1, -z], [x, 1, z], 0);
  quad([-x, 0, -z], [-x, 0, z], [-x, 1, z], [-x, 1, -z], 0);
  // Gable ends (ridge runs along x).
  tri([x, 1, z], [x, 1, -z], [x, 1 + roof, 0], 0);
  tri([-x, 1, -z], [-x, 1, z], [-x, 1 + roof, 0], 0);
  // Roof slopes with a small overhang.
  quad([-e, 0.94, e + 0.04], [e, 0.94, e + 0.04], [e, 1 + roof, 0], [-e, 1 + roof, 0], 1);
  quad([e, 0.94, -e - 0.04], [-e, 0.94, -e - 0.04], [-e, 1 + roof, 0], [e, 1 + roof, 0], 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('part', new THREE.Float32BufferAttribute(part, 1));
  return geo;
}

/** Broadleaf tree about 11 m tall at scale 1. `detailed` adds the trunk. */
export function broadleafGeometry(detailed: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const crown = new THREE.IcosahedronGeometry(1, detailed ? 1 : 0);
  crown.scale(3.6, 4.2, 3.6).translate(0, 7.2, 0);
  parts.push(tint(crown, 0.31, 0.47, 0.2));
  if (detailed) {
    const low = new THREE.IcosahedronGeometry(1, 0);
    low.scale(2.6, 2.4, 2.6).translate(1.1, 4.9, 0.6);
    parts.push(tint(low, 0.26, 0.41, 0.17));
    parts.push(tint(new THREE.CylinderGeometry(0.28, 0.42, 4.6, 5).translate(0, 2.3, 0), 0.27, 0.2, 0.13));
  }
  return merge(parts);
}

/** Conifer about 14 m tall at scale 1. */
export function coniferGeometry(detailed: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(tint(new THREE.ConeGeometry(3.0, 7.5, detailed ? 7 : 5).translate(0, 5.6, 0), 0.16, 0.31, 0.18));
  parts.push(tint(new THREE.ConeGeometry(2.1, 6.5, detailed ? 7 : 5).translate(0, 10.6, 0), 0.19, 0.36, 0.21));
  if (detailed) parts.push(tint(new THREE.CylinderGeometry(0.24, 0.36, 2.4, 5).translate(0, 1.2, 0), 0.25, 0.18, 0.12));
  return merge(parts);
}

/** Lattice-style power pylon, 1 unit tall: scale uniformly by its height. */
export function pylonGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const leg = (sx: number, sz: number) => {
    const g = new THREE.CylinderGeometry(0.008, 0.014, 1.03, 4);
    g.translate(0, 0.5, 0);
    g.rotateZ(sx * 0.085).rotateX(sz * 0.085);
    g.translate(sx * 0.085, 0, sz * 0.085);
    return g;
  };
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(leg(sx, sz));
  parts.push(new THREE.BoxGeometry(0.46, 0.014, 0.02).translate(0, 0.88, 0));
  parts.push(new THREE.BoxGeometry(0.34, 0.014, 0.02).translate(0, 0.74, 0));
  parts.push(new THREE.BoxGeometry(0.02, 0.014, 0.14).translate(0, 0.5, 0));
  parts.push(new THREE.BoxGeometry(0.14, 0.014, 0.02).translate(0, 0.5, 0));
  return tint(merge(parts), 0.5, 0.52, 0.54);
}

/** Wind turbine tower and nacelle, 1 unit to the hub. */
export function turbineTowerGeometry(): THREE.BufferGeometry {
  return tint(
    merge([
      new THREE.CylinderGeometry(0.014, 0.028, 1, 10).translate(0, 0.5, 0),
      new THREE.BoxGeometry(0.04, 0.035, 0.09).translate(0, 1.0, 0.01),
    ]),
    0.9, 0.91, 0.92,
  );
}

/** Three-bladed rotor in the XY plane, radius 0.52 of the hub height, centred on the origin. */
export function turbineRotorGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const b = new THREE.BoxGeometry(0.03, 0.5, 0.006).translate(0, 0.27, 0);
    b.rotateZ((i / 3) * Math.PI * 2);
    parts.push(b);
  }
  parts.push(new THREE.SphereGeometry(0.022, 8, 6));
  return tint(merge(parts), 0.93, 0.93, 0.94);
}

/** A small boat, 1 unit long along −Z, sitting on the waterline at y = 0. */
export function boatGeometry(): THREE.BufferGeometry {
  const hull = new THREE.BoxGeometry(0.3, 0.12, 1, 1, 1, 3);
  // Pinch the bow.
  const p = hull.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    if (z < -0.3) p.setX(i, p.getX(i) * (z < -0.45 ? 0.08 : 0.7));
    if (p.getY(i) < 0) p.setX(i, p.getX(i) * 0.75);
  }
  hull.computeVertexNormals();
  return merge([
    tint(hull.translate(0, 0.03, 0), 0.9, 0.9, 0.88),
    tint(new THREE.BoxGeometry(0.2, 0.1, 0.3).translate(0, 0.14, 0.12), 0.25, 0.33, 0.42),
  ]);
}

/** Street-light pole with an arm, 1 unit tall. */
export function lampPoleGeometry(): THREE.BufferGeometry {
  return tint(
    merge([
      new THREE.BoxGeometry(0.018, 1, 0.018).translate(0, 0.5, 0),
      new THREE.BoxGeometry(0.12, 0.012, 0.022).translate(0.05, 0.995, 0),
    ]),
    0.3, 0.31, 0.33,
  );
}

/** Helipad marking: a circle, an H and a border, drawn to a canvas. */
export function helipadTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#3c4044';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#e8c93a';
  g.lineWidth = 8;
  g.strokeRect(8, 8, 240, 240);
  g.strokeStyle = '#f2f2f0';
  g.lineWidth = 10;
  g.beginPath();
  g.arc(128, 128, 88, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#f2f2f0';
  g.fillRect(84, 74, 20, 108);
  g.fillRect(152, 74, 20, 108);
  g.fillRect(84, 118, 88, 20);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
