import { describe, expect, it } from 'vitest';
import { TUNING } from '../../src/data/tuning';
import { Warn } from '../../src/sim/types';
import { hold, holdUntil, onGround, runUntil, startEngine, tap } from './helpers';

const GREEN = TUNING.engine.greenMin;

describe('engine start and rotor spool', () => {
  it('J starts the engine and the rotor spools up slowly, reaching the green in about 15 s', () => {
    const { sim, heli } = onGround();
    sim.run(1);
    expect(heli.engine).toBe('off');
    expect(heli.rotorN).toBe(0);

    let tGreen = Infinity;
    sim.play([{ t: 0, press: 'KeyJ' }, { t: 0.05, release: 'KeyJ' }], 25, (s) => {
      if (tGreen === Infinity && s.heli.rotorN >= GREEN) tGreen = s.time - 1;
      if (Math.abs(s.time - 1 - 5) < 1e-6) expect(s.heli.rotorN).toBeLessThan(0.5); // still slow at 5 s
    });
    expect(tGreen).toBeGreaterThan(10);
    expect(tGreen).toBeLessThan(18);
    expect(heli.engine).toBe('running');
    expect(heli.rotorN).toBeGreaterThan(0.98);
    expect(heli.rotorN).toBeLessThan(1.03);
    expect(heli.tel.onGround).toBe(true);
  });

  it('Space cannot lift off before the rotor is in the green, even at the lightest weight', () => {
    const { sim, heli } = onGround('medium', { fuelFraction: 0.1, payload: 0 });
    sim.run(1);
    const restY = heli.pos.y;
    let maxRadar = 0, maxRise = 0, sawWarning = false;
    // Start the engine and hold Space through and well past the normal spool time.
    sim.play([{ t: 0, press: 'KeyJ' }, { t: 0.05, release: 'KeyJ' }, { t: 0.5, press: 'Space' }], 40, (s) => {
      maxRadar = Math.max(maxRadar, s.heli.tel.radarAlt);
      maxRise = Math.max(maxRise, s.heli.pos.y - restY);
      if (s.heli.tel.warnings & Warn.LowerCollective) sawWarning = true;
      expect(s.heli.tel.onGround).toBe(true);
    });
    expect(heli.collective).toBe(1);
    expect(maxRadar).toBeLessThan(0.01); // wheels never left the ground
    expect(maxRise).toBeLessThan(0.2); // only the suspension unloading
    expect(heli.rotorN).toBeLessThan(GREEN); // the loaded rotor never reached flight RPM
    expect(heli.engine).toBe('starting');
    expect(sawWarning).toBe(true);
    sim.keyUp('Space');

    // Lower the lever: the start completes. Raise it again: now it flies.
    hold(sim, 'ShiftLeft', 3);
    expect(heli.collective).toBe(0);
    const t = runUntil(sim, () => heli.engine === 'running' && heli.rotorN > 0.99, 30);
    expect(t).toBeLessThan(30);
    let rpmAtLiftoff = 0;
    sim.keyDown('Space');
    runUntil(sim, () => {
      if (!heli.tel.onGround && rpmAtLiftoff === 0) rpmAtLiftoff = heli.rotorN;
      return heli.tel.radarAlt > 3;
    }, 15);
    sim.keyUp('Space');
    expect(heli.tel.radarAlt).toBeGreaterThan(3);
    expect(rpmAtLiftoff).toBeGreaterThanOrEqual(GREEN);
  });

  it('after the start, Space raises the collective and the aircraft lifts off', () => {
    const { sim, heli } = onGround();
    const spool = startEngine(sim);
    expect(spool).toBeGreaterThan(10);
    expect(spool).toBeLessThan(20);
    expect(heli.tel.onGround).toBe(true);
    const held = holdUntil(sim, 'Space', () => !heli.tel.onGround && heli.tel.radarAlt > 1, 10);
    expect(held).toBeLessThan(4);
    expect(heli.rotorN).toBeGreaterThanOrEqual(GREEN);
    expect(heli.vel.y).toBeGreaterThan(0.3);
    // Nothing but thrust did that: collective is above the hover setting.
    expect(heli.collective).toBeGreaterThan(0.5);
  });

  it('J again shuts down and the rotor spools down gradually', () => {
    const { sim, heli } = onGround();
    startEngine(sim);
    sim.run(5); // governor settled at 100 %
    tap(sim, 'KeyJ');
    expect(heli.engine).toBe('off');
    let prev = heli.rotorN, monotonic = true;
    sim.run(5, (s) => {
      if (s.heli.rotorN > prev + 1e-9) monotonic = false;
      prev = s.heli.rotorN;
    });
    expect(monotonic).toBe(true);
    expect(heli.rotorN).toBeGreaterThan(0.6); // still turning well after 5 s
    expect(heli.rotorN).toBeLessThan(0.97);
    sim.run(85);
    expect(heli.rotorN).toBeLessThan(0.02);
    expect(heli.tel.onGround).toBe(true);
  });

  it('keys do nothing with the rotor stopped: no key applies a force', () => {
    const { sim, heli } = onGround();
    sim.run(2);
    const p0 = heli.pos.clone(), q0 = heli.q.clone();
    for (const k of ['KeyW', 'KeyD', 'KeyE', 'Space']) sim.keyDown(k);
    sim.run(6);
    for (const k of ['KeyW', 'KeyD', 'KeyE', 'Space']) sim.keyUp(k);
    expect(Math.abs(heli.pos.x - p0.x)).toBeLessThan(1e-3);
    expect(Math.abs(heli.pos.y - p0.y)).toBeLessThan(1e-3);
    expect(Math.abs(heli.pos.z - p0.z)).toBeLessThan(1e-3);
    expect(Math.abs(heli.q.x - q0.x) + Math.abs(heli.q.y - q0.y) + Math.abs(heli.q.z - q0.z)).toBeLessThan(1e-4);
    expect(heli.collective).toBe(1); // the lever itself did move
  });
});
