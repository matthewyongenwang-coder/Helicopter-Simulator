import * as THREE from 'three';
import type { Engine } from './engine';

/** GLSL shared by the sky dome and anything that reflects it (water). */
export const SKY_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGroundColor;
uniform float uOvercast;
vec3 skyColor(vec3 d) {
  float h = max(d.y, 0.0);
  vec3 c = mix(uHorizon, uZenith, pow(h, 0.42));
  c = mix(c, uGroundColor, smoothstep(0.0, -0.12, d.y));
  float s = max(dot(d, uSunDir), 0.0);
  float glow = pow(s, 6.0) * 0.14 + pow(s, 64.0) * 0.3;
  c += uSunColor * glow * (1.0 - 0.85 * uOvercast) * smoothstep(-0.1, 0.05, d.y);
  return c;
}
`;

export interface SkyUniforms {
  [uniform: string]: THREE.IUniform;
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uZenith: { value: THREE.Color };
  uHorizon: { value: THREE.Color };
  uGroundColor: { value: THREE.Color };
  uOvercast: { value: number };
  uStars: { value: number };
}

const DAY_ZENITH = new THREE.Color(0.14, 0.32, 0.72);
const DAY_HORIZON = new THREE.Color(0.6, 0.74, 0.9);
const DUSK_ZENITH = new THREE.Color(0.13, 0.16, 0.36);
const DUSK_HORIZON = new THREE.Color(0.95, 0.5, 0.26);
const NIGHT_ZENITH = new THREE.Color(0.004, 0.007, 0.02);
const NIGHT_HORIZON = new THREE.Color(0.018, 0.028, 0.055);
const SUN_DAY = new THREE.Color(1.0, 0.96, 0.88);
const SUN_DUSK = new THREE.Color(1.0, 0.5, 0.22);
const MOON = new THREE.Color(0.45, 0.55, 0.8);
const OVERCAST = new THREE.Color(0.5, 0.53, 0.57);

const ss = (a: number, b: number, x: number) => THREE.MathUtils.smoothstep(x, a, b);

/** Sky dome, sun and ambient light, and the fog that matches them. */
export class Sky {
  readonly uniforms: SkyUniforms = {
    uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.5).normalize() },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uGroundColor: { value: new THREE.Color() },
    uOvercast: { value: 0 },
    uStars: { value: 0 },
  };
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  readonly fog = new THREE.FogExp2(0xffffff, 0.0001);
  private dome: THREE.Mesh;
  /** 0 at night, 1 in full daylight. */
  daylight = 1;
  /** Hours, 0–24. */
  timeOfDay = 10;
  /** 0 clear … 1 fully overcast; set by the weather. */
  overcast = 0;
  /** Extra fog density multiplier from the weather. */
  haze = 1;

  constructor(private engine: Engine) {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
          gl_Position = p;
        }`,
      fragmentShader: /* glsl */ `
        ${SKY_GLSL}
        uniform float uStars;
        varying vec3 vDir;
        float hash13(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.zyx + 31.32);
          return fract((p.x + p.y) * p.z);
        }
        void main() {
          vec3 d = normalize(vDir);
          vec3 c = skyColor(d);
          float s = dot(d, uSunDir);
          // Sun (or moon) disc.
          c += uSunColor * smoothstep(0.99955, 0.9998, s) * 6.0 * (1.0 - uOvercast);
          // Stars.
          if (uStars > 0.01 && d.y > 0.0) {
            vec3 q = d * 420.0;
            vec3 g = floor(q);
            float h = hash13(g);
            // A soft round point inside the cell, not the whole cell.
            float r = length(fract(q) - 0.5);
            float star = step(0.9972, h) * (0.35 + 0.65 * hash13(g + 7.0)) * smoothstep(0.42, 0.1, r);
            c += vec3(star) * uStars * smoothstep(0.0, 0.25, d.y) * (1.0 - uOvercast);
          }
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    engine.scene.add(this.dome);
    engine.scene.add(this.sun, this.sun.target, this.hemi);
    engine.scene.fog = this.fog;
    this.setTime(this.timeOfDay);
  }

  /** Set the time of day in hours and refresh every colour that depends on it. */
  setTime(hours: number): void {
    this.timeOfDay = ((hours % 24) + 24) % 24;
    const u = this.uniforms;
    const theta = (Math.PI * (this.timeOfDay - 6)) / 12;
    const elev = Math.sin(theta) * 1.02; // sine of sun elevation, roughly
    const el = Math.asin(THREE.MathUtils.clamp(elev * 0.88, -1, 1));
    const sunDir = new THREE.Vector3(Math.cos(theta) * Math.cos(el), Math.sin(el), Math.sin(theta) * 0.55 * Math.cos(el) + 0.25).normalize();

    const day = ss(-0.02, 0.32, elev);
    const night = 1 - ss(-0.28, -0.04, elev);
    const dusk = Math.max(0, 1 - day - night);
    this.daylight = THREE.MathUtils.clamp(day + 0.35 * dusk, 0, 1);

    const zen = u.uZenith.value.setRGB(0, 0, 0), hor = u.uHorizon.value.setRGB(0, 0, 0);
    const add = (c: THREE.Color, a: THREE.Color, w: number) => c.setRGB(c.r + a.r * w, c.g + a.g * w, c.b + a.b * w);
    add(zen, DAY_ZENITH, day); add(zen, DUSK_ZENITH, dusk); add(zen, NIGHT_ZENITH, night);
    add(hor, DAY_HORIZON, day); add(hor, DUSK_HORIZON, dusk); add(hor, NIGHT_HORIZON, night);
    // Overcast flattens everything toward grey, scaled by how much light there is.
    const grey = OVERCAST.clone().multiplyScalar(0.06 + 0.94 * this.daylight);
    zen.lerp(grey.clone().multiplyScalar(0.75), this.overcast);
    hor.lerp(grey, this.overcast);
    u.uGroundColor.value.copy(hor).multiplyScalar(0.92);
    u.uOvercast.value = this.overcast;
    u.uStars.value = night;

    // The light source: sun by day, moon by night (opposite side of the sky).
    const sunCol = SUN_DAY.clone().lerp(SUN_DUSK, 1 - ss(0.0, 0.35, elev));
    if (elev > -0.08) {
      u.uSunDir.value.copy(sunDir);
      u.uSunColor.value.copy(sunCol);
      this.sun.color.copy(sunCol);
      this.sun.intensity = 3.2 * ss(-0.06, 0.22, elev) * (1 - 0.8 * this.overcast);
    } else {
      u.uSunDir.value.copy(sunDir).multiplyScalar(-1);
      u.uSunDir.value.y = Math.abs(u.uSunDir.value.y) * 0.8 + 0.25;
      u.uSunDir.value.normalize();
      u.uSunColor.value.copy(MOON).multiplyScalar(0.35);
      this.sun.color.copy(MOON);
      this.sun.intensity = 0.22 * night * (1 - 0.7 * this.overcast);
    }
    this.hemi.color.copy(zen).lerp(hor, 0.5).multiplyScalar(1.0);
    this.hemi.groundColor.setRGB(0.32, 0.3, 0.26).multiplyScalar(0.25 + 0.75 * this.daylight);
    this.hemi.intensity = 0.35 + 1.5 * this.daylight + 0.5 * this.overcast * this.daylight;
    this.fog.color.copy(hor);
    this.fog.density = (2.0 / this.engine.quality.viewDistance) * this.haze;
  }

  /** Keep the dome and the sun light centred on the camera. */
  update(focus: THREE.Vector3): void {
    const cam = this.engine.camera;
    this.dome.position.copy(cam.position);
    this.dome.scale.setScalar(1000);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.uniforms.uSunDir.value, 400);
  }
}
