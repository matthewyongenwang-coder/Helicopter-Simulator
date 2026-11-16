import * as THREE from 'three';
import type { Engine } from './engine';
import { SKY_GLSL, type Sky } from './sky';

/**
 * Cloud field shared by the cloud layer and the terrain (for cloud shadows).
 * A cloud is a column with a flat base and a height that follows a 2-D noise
 * field, so the layer reads as cumulus from below and from above, and turns into
 * a solid deck as cover approaches 1.
 */
export const CLOUD_GLSL = /* glsl */ `
uniform float uCloudBase;
uniform float uCloudTop;
uniform float uCover;
uniform vec2 uCloudWind;
uniform vec2 uCloudOrigin;
float c_hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float c_noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(c_hash(i), c_hash(i + vec2(1.0, 0.0)), f.x), mix(c_hash(i + vec2(0.0, 1.0)), c_hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float c_fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * c_noise(p);
    p = p * 2.07 + vec2(17.13, 9.71);
    a *= 0.5;
  }
  return s / 0.9375;
}
// Height of the cloud column at a world (x, z), as a fraction of the layer depth. <= 0: clear sky.
float cloudColumn(vec2 xz) {
  vec2 q = (xz + uCloudWind) / 1900.0;
  float n = c_fbm(q);
  float thr = mix(0.82, 0.08, uCover);
  float top = smoothstep(thr, thr + 0.28, n) * (0.5 + 0.5 * uCover);
  // Eroded edges and cauliflower tops.
  top -= 0.16 * (c_noise(q * 7.3 + 1.7) - 0.35) * (1.0 - 0.6 * uCover);
  return top;
}
`;

export interface CloudUniforms {
  [k: string]: THREE.IUniform;
  uCloudBase: { value: number };
  uCloudTop: { value: number };
  uCover: { value: number };
  uCloudWind: { value: THREE.Vector2 };
  uCloudOrigin: { value: THREE.Vector2 };
}

/** The cloud layer: two big planes (base and top) that ray-march the slab between them. */
export class Clouds {
  readonly uniforms: CloudUniforms = {
    uCloudBase: { value: 1300 },
    uCloudTop: { value: 1900 },
    uCover: { value: 0.4 },
    uCloudWind: { value: new THREE.Vector2() },
    uCloudOrigin: { value: new THREE.Vector2() },
  };
  private planes: THREE.Mesh[] = [];
  private mat: THREE.ShaderMaterial;
  private extra: Record<string, THREE.IUniform>;
  enabled: boolean;

  constructor(private engine: Engine, sky: Sky) {
    this.enabled = engine.quality.clouds;
    this.extra = {
      uDaylight: { value: 1 },
      uFar: { value: engine.quality.viewDistance * 1.6 },
      uFogDensity: { value: 0.0001 },
      uStorm: { value: 0 },
      uFlash: { value: 0 },
    };
    const steps = engine.qualityName === 'high' ? 14 : 9;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...sky.uniforms, ...this.uniforms, ...this.extra },
      defines: { STEPS: steps },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        ${SKY_GLSL}
        ${CLOUD_GLSL}
        uniform float uDaylight;
        uniform float uFar;
        uniform float uFogDensity;
        uniform float uStorm;
        uniform float uFlash;
        varying vec3 vWorld;
        void main() {
          vec3 ro = cameraPosition;
          vec3 rd = normalize(vWorld - ro);
          if (abs(rd.y) < 1e-4) discard;
          float ta = (uCloudBase - ro.y) / rd.y, tb = (uCloudTop - ro.y) / rd.y;
          float t0 = max(0.0, min(ta, tb)), t1 = max(ta, tb);
          if (t1 <= t0) discard;
          t1 = min(t1, t0 + 2600.0);
          float depth = uCloudTop - uCloudBase;
          float dt = (t1 - t0) / float(STEPS);
          // White-noise jitter hides the banding of a short march without leaving a pattern.
          float jitter = 0.5 + 0.6 * (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5);
          bool entered = false;
          float T = 1.0;
          vec3 acc = vec3(0.0);
          float sunVis = -1.0;
          float mu = dot(rd, uSunDir);
          float phase = 0.55 + 0.9 * pow(max(mu, 0.0), 8.0) + 0.25 * mu;
          vec3 amb = mix(uHorizon, uZenith, 0.35) * 1.25 + vec3(0.04) * uDaylight;
          vec3 sun = uSunColor * (1.0 - 0.75 * uOvercast) * 1.6;
          for (int i = 0; i < STEPS; i++) {
            float t = t0 + (float(i) + jitter) * dt;
            vec3 p = ro + rd * t;
            float h = (p.y - uCloudBase) / depth;
            float top = cloudColumn(p.xz + uCloudOrigin);
            float d = smoothstep(0.0, 0.12, top - h) * smoothstep(-0.02, 0.06, h);
            if (!entered && d > 0.002) {
              // Find the cloud's edge between the last clear sample and this one, so silhouettes are crisp.
              entered = true;
              float lo = max(t0, t - dt), hi = t;
              for (int b = 0; b < 4; b++) {
                float mid = 0.5 * (lo + hi);
                vec3 q = ro + rd * mid;
                float hq = (q.y - uCloudBase) / depth;
                if (cloudColumn(q.xz + uCloudOrigin) - hq > 0.0 && hq > -0.02) hi = mid; else lo = mid;
              }
              t = hi + 0.5 * dt * 0.5;
              p = ro + rd * t;
              h = (p.y - uCloudBase) / depth;
              top = cloudColumn(p.xz + uCloudOrigin);
              d = smoothstep(0.0, 0.12, top - h) * smoothstep(-0.02, 0.06, h);
            }
            if (d > 0.002) {
              if (sunVis < 0.0) {
                // Once per pixel: how much cloud lies toward the sun from where the ray first enters.
                vec3 ps = p + uSunDir * 260.0;
                float occ = max(cloudColumn(ps.xz + uCloudOrigin) - (ps.y - uCloudBase) / depth, 0.0);
                sunVis = exp(-occ * depth * 0.008);
              }
              // Light reaching this point from above: less the deeper inside the column.
              float below = max(top - h, 0.0) * depth;
              float lit = exp(-below * (0.0045 + 0.004 * uCover)) * mix(0.3, 1.0, sunVis);
              float ao = mix(0.42, 1.0, clamp(h * 1.4, 0.0, 1.0));
              vec3 c = amb * ao * (1.0 - 0.55 * uStorm) + sun * lit * phase;
              c += vec3(0.75, 0.8, 1.0) * uFlash * (0.6 + 0.4 * ao);
              float a = 1.0 - exp(-d * dt * (0.012 + 0.01 * uCover));
              acc += T * a * c;
              T *= 1.0 - a;
              if (T < 0.02) break;
            }
          }
          float alpha = 1.0 - T;
          if (alpha < 0.003) discard;
          vec3 col = acc / max(alpha, 1e-3);
          // Aerial perspective and a soft edge where the layer ends.
          float dist = t0;
          float fogF = 1.0 - exp(-pow(dist * uFogDensity * 0.55, 2.0));
          col = mix(col, uHorizon, fogF);
          alpha *= 1.0 - smoothstep(uFar * 0.55, uFar, dist);
          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(geo, this.mat);
      m.frustumCulled = false;
      m.renderOrder = 20;
      engine.scene.add(m);
      this.planes.push(m);
    }
  }

  /** How deep in cloud the camera is (0 clear … cover inside the layer). */
  inside(y: number): number {
    const u = this.uniforms;
    if (!this.enabled || y < u.uCloudBase.value || y > u.uCloudTop.value) return 0;
    return u.uCover.value;
  }

  update(daylight: number, fogDensity: number, storm: number, flash: number): void {
    const cam = this.engine.camera.position;
    const u = this.uniforms;
    u.uCloudOrigin.value.set(this.engine.origin.x, this.engine.origin.z);
    const size = this.engine.quality.viewDistance * 3.2;
    const [base, top] = this.planes;
    base.visible = this.enabled && cam.y < u.uCloudTop.value && u.uCover.value > 0.02;
    top.visible = this.enabled && cam.y > u.uCloudBase.value && u.uCover.value > 0.02;
    base.position.set(cam.x, u.uCloudBase.value, cam.z);
    top.position.set(cam.x, u.uCloudTop.value, cam.z);
    base.scale.set(size, 1, size);
    top.scale.set(size, 1, size);
    this.extra.uDaylight.value = daylight;
    this.extra.uFogDensity.value = fogDensity;
    this.extra.uStorm.value = storm;
    this.extra.uFlash.value = flash;
  }
}
