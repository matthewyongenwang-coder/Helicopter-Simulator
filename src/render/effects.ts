import * as THREE from 'three';
import type { Engine } from './engine';

/** Soft round sprites with per-particle size and colour, in world space. */
class ParticlePool {
  readonly points: THREE.Points;
  readonly n: number;
  private geo: THREE.BufferGeometry;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private sizeAttr: THREE.BufferAttribute;
  // World position (doubles), velocity, life.
  private px: Float64Array;
  private py: Float64Array;
  private pz: Float64Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private size0: Float32Array;
  private size1: Float32Array;
  private drag: Float32Array;
  private buoy: Float32Array;
  private rgba: Float32Array;
  private next = 0;
  readonly uniforms = { uScale: { value: 400 } };

  constructor(engine: Engine, n: number, additive: boolean) {
    this.n = n;
    this.px = new Float64Array(n); this.py = new Float64Array(n); this.pz = new Float64Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.vz = new Float32Array(n);
    this.age = new Float32Array(n).fill(1);
    this.life = new Float32Array(n).fill(1);
    this.size0 = new Float32Array(n); this.size1 = new Float32Array(n);
    this.drag = new Float32Array(n); this.buoy = new Float32Array(n);
    this.rgba = new Float32Array(n * 4);
    this.geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('color', this.colAttr);
    this.geo.setAttribute('size', this.sizeAttr);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...this.uniforms },
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute float size;
        attribute vec4 color;
        uniform float uScale;
        varying vec4 vColor;
        #include <fog_pars_vertex>
        void main() {
          vColor = color;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = min(size * uScale / max(-mvPosition.z, 0.5), 480.0);
          if (color.a <= 0.0) gl_PointSize = 0.0;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        #include <fog_pars_fragment>
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d) * 4.0;
          if (r > 1.0) discard;
          float a = vColor.a * (1.0 - r) * (1.0 - r);
          gl_FragColor = vec4(vColor.rgb, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 30;
    engine.scene.add(this.points);
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, r: number, g: number, b: number, a: number, drag = 0.5, buoy = 0): void {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0; this.life[i] = life;
    this.size0[i] = s0; this.size1[i] = s1;
    this.drag[i] = drag; this.buoy[i] = buoy;
    this.rgba[i * 4] = r; this.rgba[i * 4 + 1] = g; this.rgba[i * 4 + 2] = b; this.rgba[i * 4 + 3] = a;
  }

  /** Move every particle; `windX/Z` is the air they drift with. */
  update(dt: number, ox: number, oz: number, windX: number, windZ: number, scale: number, light: number): void {
    this.uniforms.uScale.value = scale;
    const pos = this.posAttr.array as Float32Array, col = this.colAttr.array as Float32Array, size = this.sizeAttr.array as Float32Array;
    for (let i = 0; i < this.n; i++) {
      const t = this.age[i] / this.life[i];
      if (t >= 1) {
        col[i * 4 + 3] = 0;
        continue;
      }
      this.age[i] += dt;
      const k = Math.min(1, this.drag[i] * dt);
      this.vx[i] += (windX - this.vx[i]) * k;
      this.vz[i] += (windZ - this.vz[i]) * k;
      this.vy[i] += this.buoy[i] * dt - this.vy[i] * k;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      pos[i * 3] = this.px[i] - ox;
      pos[i * 3 + 1] = this.py[i];
      pos[i * 3 + 2] = this.pz[i] - oz;
      size[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * Math.sqrt(t);
      const fadeIn = Math.min(1, t * 8);
      col[i * 4] = this.rgba[i * 4] * light;
      col[i * 4 + 1] = this.rgba[i * 4 + 1] * light;
      col[i * 4 + 2] = this.rgba[i * 4 + 2] * light;
      col[i * 4 + 3] = this.rgba[i * 4 + 3] * fadeIn * (1 - t) * (1 - t);
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
  }

  clear(): void {
    this.age.fill(1);
    this.life.fill(1);
  }
}

/** Inputs the effects need from the game each frame. */
export interface EffectsFrame {
  dt: number;
  /** Rotor hub position (world) and radius. */
  hubX: number;
  hubY: number;
  hubZ: number;
  rotorRadius: number;
  /** Ground (or water, roof) height under the hub. */
  groundY: number;
  /** 0 terrain, 1 water, 2+ man-made surfaces. */
  surface: number;
  /** Rotor downwash strength 0–1 (thrust relative to weight, times rotor speed). */
  wash: number;
  /** Dust colour for the ground under the aircraft. */
  dust: THREE.Color;
  /** Engine exhaust point (world) and the aircraft's velocity. */
  exX: number;
  exY: number;
  exZ: number;
  velX: number;
  velY: number;
  velZ: number;
  health: number;
  destroyed: boolean;
  windX: number;
  windZ: number;
  /** Rain or snow rate 0–1. */
  precip: number;
  snow: boolean;
  /** Camera velocity (world), to streak the rain. */
  camVX: number;
  camVY: number;
  camVZ: number;
  daylight: number;
}

const RAIN_BOX = 90;

/**
 * Particle effects: rotor downwash dust and spray, engine smoke and fire when
 * damaged, an explosion when destroyed, and rain or snow around the camera.
 */
export class Effects {
  private soft: ParticlePool;
  private fire: ParticlePool;
  private rain: THREE.LineSegments;
  private rainPos: Float32Array;
  private rainOff: Float32Array;
  private rainMat: THREE.LineBasicMaterial;
  private snow: THREE.Points;
  private snowMat: THREE.PointsMaterial;
  private drops: number;
  private washAcc = 0;
  private smokeAcc = 0;
  private fireAcc = 0;
  private wasDestroyed = false;
  readonly flashLight = new THREE.PointLight(0xffa040, 0, 140, 1.6);
  private rnd = Math.random;

  constructor(private engine: Engine) {
    const q = engine.qualityName;
    this.soft = new ParticlePool(engine, q === 'low' ? 700 : 1400, false);
    this.fire = new ParticlePool(engine, q === 'low' ? 200 : 400, true);
    this.drops = q === 'low' ? 1800 : q === 'medium' ? 3600 : 6000;

    this.rainOff = new Float32Array(this.drops * 3);
    for (let i = 0; i < this.rainOff.length; i++) this.rainOff[i] = (this.rnd() - 0.5) * RAIN_BOX;
    this.rainPos = new Float32Array(this.drops * 6);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.rainMat = new THREE.LineBasicMaterial({ color: 0xaab4c0, transparent: true, opacity: 0, depthWrite: false, fog: false });
    this.rain = new THREE.LineSegments(rg, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 40;
    engine.scene.add(this.rain);

    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.drops * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.snowMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.09, transparent: true, opacity: 0, depthWrite: false, fog: false });
    this.snow = new THREE.Points(sg, this.snowMat);
    this.snow.frustumCulled = false;
    this.snow.renderOrder = 40;
    engine.scene.add(this.snow);
    engine.scene.add(this.flashLight);
  }

  /** Forget everything in flight (after a respawn). */
  reset(): void {
    this.soft.clear();
    this.fire.clear();
    this.wasDestroyed = false;
    this.flashLight.intensity = 0;
  }

  update(f: EffectsFrame): void {
    const dt = f.dt;
    const o = this.engine.origin;
    if (dt > 0) {
      this.emitWash(f);
      this.emitDamage(f);
    }
    const cam = this.engine.camera;
    const scale = (this.engine.renderer.domElement.height * 0.5) / Math.tan((cam.fov * Math.PI) / 360);
    const light = 0.12 + 0.88 * f.daylight;
    this.soft.update(dt, o.x, o.z, f.windX, f.windZ, scale, light);
    this.fire.update(dt, o.x, o.z, f.windX * 0.5, f.windZ * 0.5, scale, 1);
    this.flashLight.intensity *= Math.exp(-dt * 3.5);
    if (f.destroyed) this.flashLight.intensity = Math.max(this.flashLight.intensity, 60 + 40 * this.rnd());
    this.flashLight.position.set(f.exX - o.x, f.exY + 1.5, f.exZ - o.z);
    this.updatePrecip(f);
  }

  private emitWash(f: EffectsFrame): void {
    const r = this.rnd;
    const R = f.rotorRadius;
    const h = f.hubY - f.groundY;
    const reach = 2.4 * R;
    if (f.wash < 0.05 || h > reach || h < -1) {
      this.washAcc = 0;
      return;
    }
    const k = f.wash * (1 - h / reach);
    const water = f.surface === 1;
    const paved = f.surface >= 2;
    // Paved surfaces throw up little; water throws up the most.
    const rate = k * (water ? 260 : paved ? 40 : 150) * (0.5 + R / 16);
    this.washAcc += rate * f.dt;
    const c = f.dust;
    while (this.washAcc >= 1) {
      this.washAcc -= 1;
      const a = r() * Math.PI * 2;
      const rad = R * (0.35 + 0.8 * r());
      const speed = (7 + 10 * r()) * k * (0.6 + R / 12);
      const x = f.hubX + Math.cos(a) * rad, z = f.hubZ + Math.sin(a) * rad;
      if (water) {
        this.soft.emit(x, f.groundY + 0.3, z, Math.cos(a) * speed, 0.8 + 2.5 * r(), Math.sin(a) * speed, 1.2 + r() * 1.4, 1.2, 5 + R * 0.4, 0.88, 0.92, 0.95, 0.42 * k + 0.1, 0.9, -0.6);
      } else {
        const s = 0.85 + 0.3 * r();
        this.soft.emit(x, f.groundY + 0.4, z, Math.cos(a) * speed, 0.5 + 2.2 * r(), Math.sin(a) * speed, 1.6 + r() * 1.8, 1.5, 6 + R * 0.5, c.r * s, c.g * s, c.b * s, (paved ? 0.18 : 0.38) * k + 0.05, 0.7, 0.4);
      }
    }
  }

  private emitDamage(f: EffectsFrame): void {
    const r = this.rnd;
    if (f.destroyed && !this.wasDestroyed) {
      // Explosion: a fireball, a column of smoke and a flash.
      for (let i = 0; i < 90; i++) {
        const a = r() * Math.PI * 2, e = r() * Math.PI - Math.PI / 2, s = 4 + 14 * r();
        this.fire.emit(f.exX, f.exY, f.exZ, Math.cos(a) * Math.cos(e) * s + f.velX * 0.3, Math.abs(Math.sin(e)) * s + 2, Math.sin(a) * Math.cos(e) * s + f.velZ * 0.3, 0.5 + 0.7 * r(), 1.5 + 1.5 * r(), 6 + 4 * r(), 1.0, 0.38 + 0.25 * r(), 0.08, 0.3, 2.2, 3);
      }
      for (let i = 0; i < 70; i++) {
        const a = r() * Math.PI * 2, s = 2 + 7 * r();
        this.soft.emit(f.exX, f.exY, f.exZ, Math.cos(a) * s, 2 + 6 * r(), Math.sin(a) * s, 4 + 4 * r(), 3, 16 + 8 * r(), 0.08, 0.075, 0.07, 0.75, 0.6, 1.5);
      }
      this.flashLight.intensity = 320;
    }
    this.wasDestroyed = f.destroyed;
    // Smoke from a damaged engine; thick and black once burning.
    const smoke = f.destroyed ? 26 : f.health < 0.6 ? 6 + 24 * (0.6 - f.health) : 0;
    this.smokeAcc += smoke * f.dt;
    while (this.smokeAcc >= 1) {
      this.smokeAcc -= 1;
      const g = f.destroyed || f.health < 0.3 ? 0.06 : 0.32;
      this.soft.emit(f.exX + (r() - 0.5), f.exY, f.exZ + (r() - 0.5), f.velX * 0.6 + (r() - 0.5) * 1.5, f.velY * 0.6 + 1.5 + r(), f.velZ * 0.6 + (r() - 0.5) * 1.5, 3 + 3 * r(), 1.2, 9 + 6 * r(), g, g * 0.97, g * 0.94, f.destroyed ? 0.7 : 0.5, 0.35, 1.2);
    }
    const fire = f.destroyed ? 40 : f.health < 0.3 ? 22 : 0;
    this.fireAcc += fire * f.dt;
    while (this.fireAcc >= 1) {
      this.fireAcc -= 1;
      this.fire.emit(f.exX + (r() - 0.5) * 1.2, f.exY + (r() - 0.5) * 0.6, f.exZ + (r() - 0.5) * 1.2, f.velX * 0.8, f.velY * 0.8 + 2 + 2 * r(), f.velZ * 0.8, 0.35 + 0.35 * r(), 1.4, 0.4, 1.0, 0.42 + 0.3 * r(), 0.1, 0.55, 1.5, 4);
    }
  }

  private updatePrecip(f: EffectsFrame): void {
    const rain = f.snow ? 0 : f.precip;
    const snow = f.snow ? f.precip : 0;
    this.rain.visible = rain > 0.02;
    this.snow.visible = snow > 0.02;
    if (!this.rain.visible && !this.snow.visible) return;
    const cam = this.engine.camera.position;
    const dt = f.dt;
    const fall = f.snow ? 1.3 : 9.5;
    // Drop velocity relative to the camera: falling, blown by the wind, and the camera's own motion.
    const rvx = f.windX - f.camVX, rvy = -fall - f.camVY, rvz = f.windZ - f.camVZ;
    const half = RAIN_BOX / 2;
    const off = this.rainOff;
    const n = Math.floor(this.drops * f.precip);
    const t = this.engine.timeUniform.value;
    for (let i = 0; i < this.drops; i++) {
      let x = off[i * 3] + rvx * dt, y = off[i * 3 + 1] + rvy * dt, z = off[i * 3 + 2] + rvz * dt;
      if (f.snow) {
        x += Math.sin(t * 1.3 + i) * 0.6 * dt;
        z += Math.cos(t * 1.1 + i * 1.7) * 0.6 * dt;
      }
      // Wrap into the box around the camera.
      x = ((((x + half) % RAIN_BOX) + RAIN_BOX) % RAIN_BOX) - half;
      y = ((((y + half) % RAIN_BOX) + RAIN_BOX) % RAIN_BOX) - half;
      z = ((((z + half) % RAIN_BOX) + RAIN_BOX) % RAIN_BOX) - half;
      off[i * 3] = x; off[i * 3 + 1] = y; off[i * 3 + 2] = z;
    }
    if (this.rain.visible) {
      const p = this.rainPos;
      // Streak length is the distance moved in 1/30 s, so fast flight stretches the rain.
      const sl = 1 / 30;
      for (let i = 0; i < this.drops; i++) {
        const live = i < n;
        const x = cam.x + off[i * 3], y = cam.y + off[i * 3 + 1], z = cam.z + off[i * 3 + 2];
        p[i * 6] = x; p[i * 6 + 1] = live ? y : -1e5; p[i * 6 + 2] = z;
        p[i * 6 + 3] = x - rvx * sl; p[i * 6 + 4] = live ? y - rvy * sl : -1e5; p[i * 6 + 5] = z - rvz * sl;
      }
      (this.rain.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      this.rainMat.opacity = 0.18 + 0.25 * rain;
      this.rainMat.color.setRGB(0.55, 0.6, 0.66).multiplyScalar(0.25 + 0.75 * f.daylight);
    }
    if (this.snow.visible) {
      const attr = this.snow.geometry.getAttribute('position') as THREE.BufferAttribute;
      const p = attr.array as Float32Array;
      for (let i = 0; i < this.drops; i++) {
        p[i * 3] = cam.x + off[i * 3];
        p[i * 3 + 1] = i < n ? cam.y + off[i * 3 + 1] : -1e5;
        p[i * 3 + 2] = cam.z + off[i * 3 + 2];
      }
      attr.needsUpdate = true;
      this.snowMat.opacity = 0.85;
      this.snowMat.color.setScalar(0.3 + 0.7 * f.daylight);
    }
  }
}
