import * as THREE from 'three';

/** Look of the night-vision goggles. Gains multiply linear scene light. */
export const NVG = {
  /** Phosphor colour: white phosphor reads as a cool, faintly blue white. */
  phosphor: [0.86, 0.93, 1.0] as [number, number, number],
  /** Black level the tube never goes below. */
  floor: [0.012, 0.016, 0.022] as [number, number, number],
  /** Light amplification at full night and in daylight (auto-gain backs off in the light). */
  gainNight: 36,
  gainDay: 3.2,
  /** Seconds the tube takes to come up to full brightness when switched on. */
  warmUp: 0.35,
  /** Grain strength, rising as the gain climbs. */
  grain: 0.07,
  /** Radius of the eyepiece vignette, as a fraction of the screen's shorter side. */
  vignette: 0.78,
};

/**
 * White-phosphor night vision as a full-screen pass. The scene is drawn into a
 * linear HDR target, then amplified, turned to luminance, given grain, a halo
 * around bright lights and an eyepiece vignette, and written out in phosphor white.
 */
export class NightVision {
  enabled = false;
  private target: THREE.WebGLRenderTarget;
  private quad: THREE.Mesh;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;
  private size = new THREE.Vector2();
  private warm = 0;

  constructor(private renderer: THREE.WebGLRenderer, samples: number) {
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples, depthBuffer: true });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.target.texture },
        uGain: { value: 1 },
        uTime: { value: 0 },
        uRes: { value: new THREE.Vector2(1, 1) },
        uGrain: { value: NVG.grain },
        uVignette: { value: NVG.vignette },
        uPhosphor: { value: new THREE.Vector3(...NVG.phosphor) },
        uFloor: { value: new THREE.Vector3(...NVG.floor) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene;
        uniform float uGain, uTime, uGrain, uVignette;
        uniform vec2 uRes;
        uniform vec3 uPhosphor, uFloor;
        varying vec2 vUv;
        float lum(vec2 uv) { return dot(texture2D(tScene, uv).rgb, vec3(0.2126, 0.7152, 0.0722)); }
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main() {
          vec2 px = 1.0 / uRes;
          // The tube is a little soft: a small blur, plus a wide halo around bright lights.
          float l = lum(vUv) * 0.5
            + (lum(vUv + vec2(px.x, 0.0)) + lum(vUv - vec2(px.x, 0.0)) + lum(vUv + vec2(0.0, px.y)) + lum(vUv - vec2(0.0, px.y))) * 0.125;
          float halo = 0.0;
          for (int i = 0; i < 8; i++) {
            float a = float(i) * 0.785398;
            halo += max(0.0, lum(vUv + vec2(cos(a), sin(a)) * px * 9.0) * uGain - 1.2);
          }
          float v = l * uGain;
          v = 1.0 - exp(-v * 1.35);            // intensifier response: bright lights saturate, never clip hard
          v += halo * 0.02;
          float grain = hash(floor(vUv * uRes) + fract(uTime * 17.0) * 97.0) - 0.5;
          v += grain * uGrain * (0.6 + 0.4 * clamp(uGain / 12.0, 0.0, 1.0));
          // Eyepiece: a soft round edge on the shorter side of the screen.
          vec2 p = (vUv - 0.5) * uRes / min(uRes.x, uRes.y);
          float vig = smoothstep(uVignette * 0.5, uVignette * 0.5 - 0.22, length(p));
          v *= mix(0.25, 1.0, vig);
          v = clamp(v, 0.0, 1.0);
          gl_FragColor = vec4(uFloor + uPhosphor * v, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  toggle(): void {
    this.enabled = !this.enabled;
    this.warm = 0;
  }

  /** Draw the scene through the goggles. `daylight` 0–1 sets the auto-gain. */
  render(scene: THREE.Scene, camera: THREE.Camera, dt: number, daylight: number, exposure: number): void {
    const r = this.renderer;
    r.getDrawingBufferSize(this.size);
    if (this.target.width !== this.size.x || this.target.height !== this.size.y) this.target.setSize(this.size.x, this.size.y);
    this.warm = Math.min(1, this.warm + dt / NVG.warmUp);
    const u = this.material.uniforms;
    const day = Math.sqrt(THREE.MathUtils.clamp(daylight, 0, 1));
    const gain = (NVG.gainNight + (NVG.gainDay - NVG.gainNight) * day) * exposure;
    u.uGain.value = gain * this.warm * this.warm;
    u.uTime.value += dt;
    u.uRes.value.copy(this.size);
    r.setRenderTarget(this.target);
    r.render(scene, camera);
    r.setRenderTarget(null);
    r.render(this.scene, this.camera);
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
