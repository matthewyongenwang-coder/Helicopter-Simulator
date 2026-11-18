import type { AircraftData } from '../data/aircraft';
import type { AircraftVisual } from '../data/aircraftVisual';
import { Warn } from '../sim/types';

/** What the sound needs from the simulation each frame. */
export interface AudioFrame {
  dt: number;
  /** Rotor speed, fraction of nominal. */
  rotorN: number;
  engineOn: boolean;
  /** Thrust relative to weight (load on the blades). */
  load: number;
  torque: number;
  airspeed: number;
  /** Descending through the rotor's own wake: blade slap. */
  slapBoost: number;
  vibration: number;
  warnings: number;
  cockpit: boolean;
  precip: number;
  snow: boolean;
  paused: boolean;
  destroyed: boolean;
  autohover: boolean;
}

/**
 * Engine and rotor sound synthesised with Web Audio, no samples.
 *
 *   rotor:   noise amplitude-modulated by a pulse train at the blade-passing
 *            frequency (the "wop"), plus a low thump at the same rate
 *   turbine: two detuned tones at the gas-generator frequency and a hiss
 *   gearbox: a filtered sawtooth rumble
 *   wind, rain: filtered noise
 *   alerts:  master caution chime, autohover tones
 *   events:  impacts, explosion, thunder
 */
export class FlightAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private outside!: BiquadFilterNode;
  private noise!: AudioBuffer;
  private nodes: { stop(): void }[] = [];
  private p: {
    slapOsc: OscillatorNode;
    slapDepth: GainNode;
    slapGain: GainNode;
    slapFilter: BiquadFilterNode;
    thumpOsc: OscillatorNode;
    thumpGain: GainNode;
    turbA: OscillatorNode;
    turbB: OscillatorNode;
    turbGain: GainNode;
    hissGain: GainNode;
    hissFilter: BiquadFilterNode;
    rumble: OscillatorNode;
    rumbleGain: GainNode;
    windGain: GainNode;
    windFilter: BiquadFilterNode;
    rainGain: GainNode;
    rainFilter: BiquadFilterNode;
  } | null = null;
  private aircraft: AircraftData | null = null;
  private visual: AircraftVisual | null = null;
  private volume = 0.7;
  /** Gas generator speed, lags the rotor. */
  private ng = 0;
  private prevWarn = 0;
  private prevAuto = false;
  private muted = false;

  get running(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Audio can only start after a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(comp);
    // Everything outside the cabin goes through this, so the cockpit view can muffle it.
    this.outside = ctx.createBiquadFilter();
    this.outside.type = 'lowpass';
    this.outside.frequency.value = 18000;
    this.outside.connect(this.master);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    if (this.aircraft && this.visual) this.build();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.05);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.setVolume(this.volume);
  }

  setAircraft(d: AircraftData, v: AircraftVisual): void {
    this.aircraft = d;
    this.visual = v;
    this.ng = 0;
    if (this.ctx) this.build();
  }

  private noiseSource(): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.start(0, Math.random() * 1.5);
    this.nodes.push(s);
    return s;
  }

  private osc(type: OscillatorType | PeriodicWave, f: number): OscillatorNode {
    const o = this.ctx!.createOscillator();
    if (type instanceof PeriodicWave) o.setPeriodicWave(type);
    else o.type = type;
    o.frequency.value = f;
    o.start();
    this.nodes.push(o);
    return o;
  }

  private gain(v = 0): GainNode {
    const g = this.ctx!.createGain();
    g.gain.value = v;
    return g;
  }

  private filter(type: BiquadFilterType, f: number, q = 0.7): BiquadFilterNode {
    const b = this.ctx!.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }

  /** (Re)build the voice graph for the current aircraft. */
  private build(): void {
    for (const n of this.nodes) n.stop();
    this.nodes = [];
    const ctx = this.ctx!, v = this.visual!.audio;
    const out = this.outside;

    // A sharp, one-sided pulse per blade passage: the sum of harmonics with a soft rolloff.
    const H = 24;
    const real = new Float32Array(H), imag = new Float32Array(H);
    for (let k = 1; k < H; k++) real[k] = Math.pow(0.86 - 0.18 * (1 - v.slap), k) * (1 + 0.6 * v.slap);
    const pulse = ctx.createPeriodicWave(real, imag);

    // Rotor "wop": band-passed noise whose loudness follows the pulse.
    const slapGain = this.gain(0);
    const slapDepth = this.gain(0);
    const slapOsc = this.osc(pulse, 15);
    slapOsc.connect(slapDepth).connect(slapGain.gain);
    const slapFilter = this.filter('bandpass', 420, 0.8);
    this.noiseSource().connect(slapFilter).connect(slapGain).connect(out);

    // Low thump at the same rate.
    const thumpGain = this.gain(0);
    const thumpOsc = this.osc(pulse, 15);
    thumpOsc.connect(this.filter('lowpass', 140, 0.9)).connect(thumpGain).connect(out);

    // Turbine whine: two tones a little apart, and combustion hiss.
    const turbGain = this.gain(0);
    const turbA = this.osc('sine', v.turbineHz);
    const turbB = this.osc('triangle', v.turbineHz * 0.503);
    turbA.connect(turbGain);
    turbB.connect(this.gain(0.35)).connect(turbGain);
    turbGain.connect(this.master);
    const hissGain = this.gain(0);
    const hissFilter = this.filter('bandpass', 2600, 0.6);
    this.noiseSource().connect(hissFilter).connect(hissGain).connect(out);

    // Gearbox rumble.
    const rumbleGain = this.gain(0);
    const rumble = this.osc('sawtooth', v.rumbleHz);
    rumble.connect(this.filter('lowpass', v.rumbleHz * 3, 1.2)).connect(rumbleGain).connect(this.master);

    // Wind and rain.
    const windGain = this.gain(0);
    const windFilter = this.filter('lowpass', 400, 0.5);
    this.noiseSource().connect(windFilter).connect(windGain).connect(this.master);
    const rainGain = this.gain(0);
    const rainFilter = this.filter('highpass', 1800, 0.4);
    this.noiseSource().connect(rainFilter).connect(rainGain).connect(this.master);


    this.p = { slapOsc, slapDepth, slapGain, slapFilter, thumpOsc, thumpGain, turbA, turbB, turbGain, hissGain, hissFilter, rumble, rumbleGain, windGain, windFilter, rainGain, rainFilter };
  }

  update(f: AudioFrame): void {
    if (!this.ctx || !this.p || !this.aircraft || !this.visual) return;
    const p = this.p, d = this.aircraft, v = this.visual.audio;
    const t = this.ctx.currentTime, tc = 0.06;
    const set = (param: AudioParam, value: number, k = tc) => param.setTargetAtTime(value, t, k);
    const quiet = f.paused ? 0 : 1;

    // Gas generator: spools ahead of the rotor on start, winds down when off.
    const ngTarget = f.engineOn ? Math.max(0.62, f.rotorN * (0.9 + 0.12 * f.torque)) : 0;
    this.ng += (ngTarget - this.ng) * Math.min(1, f.dt * (f.engineOn ? 0.9 : 0.35));

    const R = d.rotor.diameter / 2;
    const rps = (d.rotor.tipSpeed / (2 * Math.PI * R)) * f.rotorN;
    const bpf = Math.max(0.01, rps * d.rotor.blades);
    const n = Math.min(1, f.rotorN);
    const load = Math.max(0, Math.min(1.6, f.load));
    // Slap grows with blade load, airspeed and descent through the wake.
    const slap = n * n * (0.25 + 0.5 * load + 0.008 * f.airspeed + 0.9 * f.slapBoost) * (0.6 + 0.6 * v.slap);
    set(p.slapOsc.frequency, bpf);
    set(p.thumpOsc.frequency, bpf);
    set(p.slapDepth.gain, 0.5 * slap * v.gain * quiet);
    set(p.slapGain.gain, 0.04 * slap * v.gain * quiet);
    set(p.slapFilter.frequency, 280 + 260 * load + 300 * f.slapBoost);
    set(p.thumpGain.gain, 0.22 * n * n * (0.4 + 0.6 * load) * v.gain * quiet);

    const ng = this.ng;
    set(p.turbA.frequency, v.turbineHz * (0.25 + 0.75 * ng), 0.15);
    set(p.turbB.frequency, v.turbineHz * 0.503 * (0.25 + 0.75 * ng), 0.15);
    set(p.turbGain.gain, 0.03 * v.turbineGain * ng * ng * (f.cockpit ? 1.5 : 1) * quiet);
    set(p.hissGain.gain, 0.05 * ng * (0.5 + 0.5 * f.torque) * quiet);
    set(p.hissFilter.frequency, 1800 + 1600 * ng);
    set(p.rumble.frequency, v.rumbleHz * Math.max(0.05, f.rotorN));
    set(p.rumbleGain.gain, 0.07 * n * (0.5 + 0.5 * f.torque) * (f.cockpit ? 1.6 : 1) * (1 + f.vibration) * quiet);

    const w = Math.min(1, f.airspeed / 75);
    set(p.windGain.gain, (0.02 + 0.25 * w * w) * quiet * (f.cockpit ? 0.45 : 1));
    set(p.windFilter.frequency, 250 + 2200 * w);
    set(p.rainGain.gain, f.precip * (f.snow ? 0.02 : f.cockpit ? 0.22 : 0.1) * quiet);
    set(p.rainFilter.frequency, f.cockpit ? 900 : 2000);

    // Inside the cabin the outside world is muffled.
    set(this.outside.frequency, f.cockpit ? 2400 : 18000, 0.1);

    // Master caution on any new warning, distinct tones for autohover on and off.
    const serious = Warn.EngineOut | Warn.SinkRate | Warn.TailRotor | Warn.Damage | Warn.LowFuel;
    const fresh = f.warnings & serious & ~this.prevWarn;
    if (fresh && !f.paused && !f.destroyed) this.chime([880, 660], 0.09, 0.05);
    this.prevWarn = f.warnings;
    if (f.autohover !== this.prevAuto) {
      this.chime(f.autohover ? [660, 990] : [990, 660], 0.07, 0.035);
      this.prevAuto = f.autohover;
    }
  }

  /** Short tone sequence. */
  chime(freqs: number[], each: number, level: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    let t = ctx.currentTime + 0.01;
    for (const f of freqs) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(level, t + 0.012);
      g.gain.setTargetAtTime(0, t + each * 0.7, 0.03);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + each + 0.2);
      t += each;
    }
  }

  /** A burst of filtered noise: impacts, explosions, thunder. */
  private burst(level: number, f0: number, f1: number, decay: number, delay = 0): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const b = ctx.createBiquadFilter();
    b.type = 'lowpass';
    b.frequency.setValueAtTime(f0, t);
    b.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.01);
    g.gain.setTargetAtTime(0, t + 0.02, decay / 3);
    s.connect(b).connect(g).connect(this.outside);
    s.start(t, Math.random());
    s.stop(t + decay * 2 + 0.5);
  }

  impact(speed: number): void {
    const k = Math.min(1, speed / 8);
    if (k > 0.05) this.burst(0.25 + 0.6 * k, 600 + 1800 * k, 60, 0.15 + 0.25 * k);
  }

  explode(): void {
    this.burst(1.2, 3500, 40, 2.2);
    this.burst(0.8, 200, 30, 3.5, 0.05);
  }

  /** Filtered noise with a sweeping cutoff: gunfire, whooshes, cracks. */
  private noiseHit(level: number, type: BiquadFilterType, f0: number, f1: number, decay: number, delay = 0, q = 0.7, inside = false): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.Q.value = q;
    b.frequency.setValueAtTime(f0, t);
    b.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.004);
    g.gain.setTargetAtTime(0, t + 0.01, decay / 3);
    s.connect(b).connect(g).connect(inside ? this.master : this.outside);
    s.start(t, Math.random());
    s.stop(t + decay * 2 + 0.3);
  }

  /** A short tone: lock, warnings, empty clicks. */
  tone(freq: number, dur: number, level: number, type: OscillatorType = 'sine'): void {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.005;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.008);
    g.gain.setTargetAtTime(0, t + dur * 0.8, 0.015);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.15);
  }

  /** One round from the aircraft's own gun: a sharp report over a low thump. */
  gunShot(heavy: boolean): void {
    this.noiseHit(heavy ? 0.5 : 0.36, 'lowpass', heavy ? 2600 : 3600, 160, heavy ? 0.1 : 0.07);
    this.burst(heavy ? 0.5 : 0.3, 260, 50, heavy ? 0.14 : 0.09);
  }

  /** Enemy fire heard from a distance (arrives late, sounds duller further off). */
  enemyShot(distance: number, flak: boolean): void {
    const k = Math.max(0, 1 - distance / 2200);
    if (k <= 0.02) return;
    const delay = Math.min(4, distance / 343);
    this.noiseHit((flak ? 0.3 : 0.18) * k, 'lowpass', 600 + 2400 * k, 90, flak ? 0.16 : 0.08, delay);
  }

  missileLaunch(enemy: boolean, distance: number): void {
    const k = enemy ? Math.max(0.1, 1 - distance / 4000) : 1;
    const delay = enemy ? Math.min(6, distance / 343) : 0;
    this.burst(0.5 * k, 900, 60, 0.35, delay);
    this.noiseHit(0.45 * k, 'bandpass', 500, 2600, 1.3, delay, 1.4);
  }

  flarePop(): void {
    this.noiseHit(0.32, 'highpass', 2200, 900, 0.07);
    this.noiseHit(0.12, 'bandpass', 3000, 1400, 0.6, 0.03, 2);
  }

  /** A blast: louder and deeper the bigger it is, late by the distance. */
  boom(distance: number, size: number): void {
    const k = Math.max(0.05, 1 - distance / (2500 + 2500 * size));
    const delay = Math.min(6, distance / 343);
    this.burst(Math.min(1.4, 0.55 * size * k + 0.1), 600 + 2600 * k, 35, 0.7 + 0.8 * size, delay);
    this.burst(Math.min(1.2, 0.5 * size * k), 160, 25, 1.4 + 1.2 * size, delay + 0.04);
  }

  /** A round passing close by. */
  crack(): void {
    this.noiseHit(0.32, 'highpass', 4200, 1800, 0.035);
  }

  /** A round striking the airframe. */
  ping(heavy: boolean): void {
    this.noiseHit(heavy ? 0.9 : 0.5, 'bandpass', heavy ? 1400 : 2400, 500, heavy ? 0.25 : 0.1, 0, 3, true);
    if (heavy) this.burst(0.9, 1200, 40, 1.0);
  }

  thunder(distance: number): void {
    const k = Math.max(0.15, 1 - distance / 9000);
    const delay = distance / 343;
    this.burst(0.5 * k, 900 * k + 120, 35, 2.5 + 2 * (1 - k), delay);
    this.burst(0.35 * k, 160, 25, 4, delay + 0.25);
  }
}
