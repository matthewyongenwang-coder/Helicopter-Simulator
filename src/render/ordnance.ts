import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Paint a geometry one vertex colour (sRGB hex). Returns a non-indexed copy without UVs. */
export function paint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  const col = new THREE.Color(hex);
  for (let i = 0; i < n; i++) {
    c[i * 3] = col.r;
    c[i * 3 + 1] = col.g;
    c[i * 3 + 2] = col.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** Merge painted parts into one geometry (and dispose the parts). */
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  out.computeBoundingSphere();
  return out;
}

/**
 * A missile, nose toward −Z, 1.65 m long: body, seeker dome, mid-body wings
 * and tail fins. Vertex coloured, for a vertex-colour material.
 */
export function missileGeometry(): THREE.BufferGeometry {
  const L = 1.65, r = 0.09;
  const along = (g: THREE.BufferGeometry) => g.rotateX(-Math.PI / 2);
  return merge([
    paint(along(new THREE.CylinderGeometry(r, r, L * 0.82, 10)).translate(0, 0, 0.05), 0x5c6150),
    paint(along(new THREE.SphereGeometry(r, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2)).translate(0, 0, -L * 0.36), 0x262a2c),
    paint(along(new THREE.CylinderGeometry(r * 0.75, r * 0.95, 0.1, 10)).translate(0, 0, 0.77), 0x1d1f20),
    paint(new THREE.BoxGeometry(0.42, 0.012, 0.16).translate(0, 0, -0.18), 0x4b5042),
    paint(new THREE.BoxGeometry(0.012, 0.42, 0.16).translate(0, 0, -0.18), 0x4b5042),
    paint(new THREE.BoxGeometry(0.36, 0.012, 0.12).translate(0, 0, L * 0.4), 0x4b5042),
    paint(new THREE.BoxGeometry(0.012, 0.36, 0.12).translate(0, 0, L * 0.4), 0x4b5042),
    paint(along(new THREE.CylinderGeometry(r * 1.02, r * 1.02, 0.06, 10)).translate(0, 0, -0.5), 0xd3b13a),
  ]);
}
