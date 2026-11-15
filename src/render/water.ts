import * as THREE from 'three';
import type { Engine } from './engine';
import { SKY_GLSL, type Sky } from './sky';

/**
 * One large plane at sea level that follows the camera. Waves are analytic
 * (summed directional sines evaluated per pixel), with fresnel reflection of
 * the sky function and a sun glint.
 */
export class Water {
  readonly mesh: THREE.Mesh;
  private uniforms: Record<string, THREE.IUniform>;

  constructor(private engine: Engine, sky: Sky) {
    this.uniforms = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      ...sky.uniforms,
      uTime: engine.timeUniform,
      uOffset: engine.originUniform,
      uDeep: { value: Water.DEEP },
      uScatter: { value: new THREE.Color(0.03, 0.2, 0.2) },
      uDaylight: { value: 1 },
      uWind: { value: new THREE.Vector2(1, 0.3).normalize() },
      uChop: { value: 1 },
    };
    const octaves = engine.quality.waterDetail;
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      fog: true,
      depthWrite: false,
      defines: { WAVES: octaves },
      vertexShader: /* glsl */ `
        uniform vec2 uOffset;
        varying vec3 vWorld;
        varying vec2 vWave;
        #include <fog_pars_vertex>
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vWave = wp.xz + uOffset;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        ${SKY_GLSL}
        uniform float uTime;
        uniform vec3 uDeep;
        uniform vec3 uScatter;
        uniform float uDaylight;
        uniform vec2 uWind;
        uniform float uChop;
        varying vec3 vWorld;
        varying vec2 vWave;
        #include <fog_pars_fragment>

        // Slope of the wave field: a sum of directional waves, each faded out
        // once it is too fine to resolve at this distance.
        vec2 waveSlope(vec2 p, float px) {
          vec2 g = vec2(0.0);
          float L = 83.0, A = 0.34, ang = 0.0;
          for (int i = 0; i < WAVES; i++) {
            vec2 dir = vec2(uWind.x * cos(ang) - uWind.y * sin(ang), uWind.x * sin(ang) + uWind.y * cos(ang));
            float k = 6.2831853 / L;
            // Drop a wave once a pixel covers more than a quarter of its length.
            float fade = clamp((L / px - 4.0) / 6.0, 0.0, 1.0);
            // Bend the wave fronts a little so they do not read as ruled lines.
            vec2 q = p + 0.35 * L * vec2(sin(p.y * k * 0.37 + float(i)), cos(p.x * k * 0.41 - float(i) * 2.0));
            float ph = dot(dir, q) * k + uTime * sqrt(9.81 * k) + float(i) * 1.7;
            g += dir * (A * k * cos(ph)) * fade;
            L *= 0.53; A *= 0.56;
            ang += (mod(float(i), 2.0) < 0.5 ? 1.0 : -1.0) * (0.55 + 0.33 * float(i));
          }
          return g * uChop;
        }

        void main() {
          vec3 toCam = cameraPosition - vWorld;
          float dist = length(toCam);
          vec3 V = toCam / dist;
          float px = max(length(dFdx(vWave)), length(dFdy(vWave)));
          vec2 sl = waveSlope(vWave, px);
          vec3 N = normalize(vec3(-sl.x, 1.0, -sl.y));
          float ndv = max(dot(N, V), 0.0);
          float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
          vec3 R = reflect(-V, N);
          R.y = abs(R.y) + 0.02;
          vec3 refl = skyColor(normalize(R));
          // Water body colour: darker looking straight down, lighter on wave faces toward the sun.
          float facing = max(dot(N, uSunDir), 0.0);
          vec3 body = (uDeep + uScatter * 0.25 * facing) * (0.08 + 0.92 * uDaylight);
          vec3 col = mix(body, refl, F);
          // Sun glint.
          float spec = pow(max(dot(normalize(R), uSunDir), 0.0), 320.0);
          col += uSunColor * spec * 2.2 * (1.0 - uOvercast);
          float alpha = mix(0.78, 1.0, F);
          alpha = max(alpha, smoothstep(250.0, 2200.0, dist));
          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    engine.scene.add(this.mesh);

    // A dark floor far below, so deep water looks the same whether or not a sea-bed
    // chunk happens to be loaded under it.
    this.floorMat = new THREE.MeshBasicMaterial({ color: 0x000000, fog: true });
    this.floor = new THREE.Mesh(geo, this.floorMat);
    this.floor.frustumCulled = false;
    engine.scene.add(this.floor);
  }

  private floor: THREE.Mesh;
  private floorMat: THREE.MeshBasicMaterial;
  /** Linear colour the sea bed fades to with depth. Shared with the terrain shader. */
  static readonly DEEP = new THREE.Color(0.012, 0.075, 0.115);

  setWind(x: number, z: number, chop: number): void {
    const l = Math.hypot(x, z);
    if (l > 0.01) (this.uniforms.uWind.value as THREE.Vector2).set(x / l, z / l);
    this.uniforms.uChop.value = chop;
  }

  update(daylight: number): void {
    const cam = this.engine.camera.position;
    const size = this.engine.quality.viewDistance * 4;
    this.mesh.scale.set(size, 1, size);
    this.mesh.position.set(cam.x, 0, cam.z);
    this.uniforms.uDaylight.value = daylight;
    this.floor.scale.set(size, 1, size);
    this.floor.position.set(cam.x, -40, cam.z);
    this.floorMat.color.copy(Water.DEEP).multiplyScalar(0.08 + 0.92 * daylight);
  }
}
