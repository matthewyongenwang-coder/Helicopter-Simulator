import * as THREE from 'three';
import { GRAPHICS, TERRAIN_LOD, type GraphicsPreset, type QualityName } from '../data/graphics';
import { NightVision } from './nightVision';

/**
 * Renderer, scene, camera and the floating origin.
 *
 * World coordinates are doubles and can be millions of metres from zero.
 * Everything handed to the GPU is positioned relative to `origin`, which is
 * re-centred on the camera in whole steps so 32-bit floats never lose precision.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  quality: GraphicsPreset;
  qualityName: QualityName;

  /** World position of the scene origin (x, z only: heights stay small). */
  readonly origin = { x: 0, z: 0 };
  private rebaseListeners: (() => void)[] = [];
  /** Shared uniform: the origin wrapped to a tile period, for world-anchored shader noise. */
  readonly originUniform = { value: new THREE.Vector2() };
  readonly timeUniform = { value: 0 };
  readonly nightVision: NightVision;

  constructor(canvas: HTMLCanvasElement, quality: QualityName) {
    this.canvas = canvas;
    this.qualityName = quality;
    this.quality = GRAPHICS[quality];
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.quality.antialias,
      powerPreference: 'high-performance',
      reversedDepthBuffer: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.82;
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Without a reversed depth buffer the far terrain needs a more distant near plane.
    const reversed = this.renderer.capabilities.reversedDepthBuffer;
    this.camera = new THREE.PerspectiveCamera(62, 1, reversed ? 0.35 : 1.2, 60000);
    this.scene.add(this.camera);
    this.nightVision = new NightVision(this.renderer, this.quality.antialias ? 4 : 0);
    this.resize();
  }

  setQuality(name: QualityName): void {
    this.qualityName = name;
    this.quality = GRAPHICS[name];
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.resize();
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  onRebase(fn: () => void): void {
    this.rebaseListeners.push(fn);
  }

  /** World → scene coordinates. */
  toScene(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(x - this.origin.x, y, z - this.origin.z);
  }

  /** Move the origin if the focus point has wandered too far. Returns true if it moved. */
  updateOrigin(focusX: number, focusZ: number): boolean {
    const L = TERRAIN_LOD;
    if (Math.abs(focusX - this.origin.x) < L.rebaseDistance && Math.abs(focusZ - this.origin.z) < L.rebaseDistance) return false;
    this.origin.x = Math.round(focusX / L.rebaseSnap) * L.rebaseSnap;
    this.origin.z = Math.round(focusZ / L.rebaseSnap) * L.rebaseSnap;
    this.originUniform.value.set(((this.origin.x % 4096) + 4096) % 4096, ((this.origin.z % 4096) + 4096) % 4096);
    for (const fn of this.rebaseListeners) fn();
    return true;
  }

  /** Draw a frame, through the night-vision goggles when they are on. */
  render(dt = 0, daylight = 1): void {
    if (this.nightVision.enabled) this.nightVision.render(this.scene, this.camera, dt, daylight, this.renderer.toneMappingExposure);
    else this.renderer.render(this.scene, this.camera);
  }
}
