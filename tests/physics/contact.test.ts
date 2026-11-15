import { describe, expect, it } from 'vitest';
import { AIRCRAFT } from '../../src/data/aircraft';
import { deriveAircraft } from '../../src/sim/derive';
import { Warn } from '../../src/sim/types';
import { deg, hold, holdUntil, inHover, onGround, runUntil, tap, tiltDeg } from './helpers';

const AC = deriveAircraft(AIRCRAFT.medium);

/** Drop a parked aircraft onto the ground at a given sink rate. */
function drop(id: string, sinkRate: number) {
  const rig = onGround(id);
  rig.heli.pos.y += 0.03; // just clear of the ground, so the touchdown speed is the one asked for
  rig.heli.vel.y = -sinkRate;
  rig.sim.run(4);
  return rig.heli;
}

describe('landing gear and suspension', () => {
  it('sits still on its gear at the resting height', () => {
    for (const id of ['medium', 'scout']) {
      const { sim, heli } = onGround(id);
      sim.run(4);
      const p = heli.pos.clone();
      sim.run(10);
      expect(heli.tel.onGround).toBe(true);
      expect(heli.pos.y).toBeGreaterThan(heli.ac.restHeight - 0.04);
      expect(heli.pos.y).toBeLessThan(heli.ac.restHeight + 0.04);
      expect(heli.pos.clone().sub(p).len()).toBeLessThan(1e-3); // no creep, no jitter
      expect(heli.vel.len()).toBeLessThan(1e-3);
      expect(tiltDeg(heli)).toBeLessThan(0.5);
      expect(heli.tel.gearLoad).toBeGreaterThan(0.98);
      expect(heli.tel.gearLoad).toBeLessThan(1.02);
      expect(heli.health).toBe(1);
    }
  });

  it('the suspension compresses under load and absorbs a firm touchdown', () => {
    const heli = drop('medium', 2.0);
    expect(heli.health).toBe(1);
    expect(heli.tel.onGround).toBe(true);
    expect(heli.vel.len()).toBeLessThan(0.01);
    const compression = heli.points.filter((p) => p.kind === 0).map((p) => p.compression);
    for (const c of compression) {
      expect(c).toBeGreaterThan(0.03);
      expect(c).toBeLessThan(AIRCRAFT.medium.gear.stroke);
    }
  });

  it('a hard landing damages the aircraft; a crash destroys it', () => {
    const firm = drop('medium', AIRCRAFT.medium.damage.hardLanding - 0.5);
    expect(firm.health).toBe(1);

    const hard = drop('medium', 6);
    expect(hard.destroyed).toBe(false);
    expect(hard.health).toBeLessThan(0.95);
    expect(hard.health).toBeGreaterThan(0.2);

    const crash = drop('medium', 14);
    expect(crash.destroyed).toBe(true);
    expect(crash.health).toBe(0);
    expect(crash.engine).toBe('failed');
  });

  it('a controlled descent on the collective lands without damage', () => {
    const { sim, heli } = inHover('medium', AC.restHeight + 4);
    // Ease the lever down a little and let it settle onto the ground.
    hold(sim, 'ShiftLeft', 0.18);
    const t = runUntil(sim, () => heli.tel.onGround, 40);
    expect(t).toBeLessThan(40);
    hold(sim, 'ShiftLeft', 3);
    sim.run(3);
    expect(heli.tel.onGround).toBe(true);
    expect(heli.tel.gearLoad).toBeGreaterThan(0.8);
    expect(heli.health).toBe(1);
    expect(heli.tel.lastImpact).toBeLessThan(AIRCRAFT.medium.damage.hardLanding);
    expect(heli.vel.len()).toBeLessThan(0.05);
  });
});

describe('collisions', () => {
  it('a rotor strike destroys the aircraft', () => {
    const { sim, heli } = inHover('medium', AC.restHeight + 5);
    hold(sim, 'KeyD', 2.2); // roll well past knife-edge, close to the ground
    runUntil(sim, () => heli.destroyed, 6);
    expect(heli.destroyed).toBe(true);
    expect(heli.destroyedReason).toMatch(/rotor|crash/i);
    expect(heli.tel.thrust).toBe(0);
    // The wreck comes to rest instead of bouncing forever or sinking through the ground.
    sim.run(12);
    expect(heli.vel.len()).toBeLessThan(0.5);
    expect(heli.pos.y).toBeGreaterThan(0);
    expect(heli.pos.y).toBeLessThan(6);
  });

  it('a tail strike takes out the tail rotor and the aircraft spins', () => {
    const { sim, heli } = inHover('medium', AC.restHeight + 3.2);
    holdUntil(sim, 'KeyS', () => !heli.tailRotorOk || heli.destroyed, 3);
    expect(heli.tailRotorOk).toBe(false);
    if (!heli.destroyed) {
      expect(heli.tel.warnings & Warn.TailRotor).toBeTruthy();
      expect(heli.health).toBeLessThan(1);
    }
  });

  it('with the tail rotor gone in flight, engine torque spins the fuselage right', () => {
    const { sim, heli } = inHover('medium', 200);
    heli.tailRotorOk = false;
    sim.run(2);
    expect(heli.tel.yawRate).toBeGreaterThan(0.5); // rad/s and growing
    // Pedal has nothing to act through.
    sim.keyDown('KeyQ');
    sim.run(1);
    sim.keyUp('KeyQ');
    expect(heli.tel.yawRate).toBeGreaterThan(0.5);
  });

  it('flying into the ground at speed destroys it', () => {
    const { sim, heli } = inHover('medium', 40, { speed: 45 });
    hold(sim, 'KeyW', 1.0);
    runUntil(sim, () => heli.destroyed, 15);
    expect(heli.destroyed).toBe(true);
  });

  it('ditching in water is not survivable', () => {
    const { sim, heli, env } = inHover('medium', AC.restHeight + 3);
    env.waterFromX = -1e9; // everything is water
    tap(sim, 'KeyJ'); // engine off
    hold(sim, 'ShiftLeft', 2.5);
    runUntil(sim, () => heli.destroyed, 20);
    expect(heli.destroyed).toBe(true);
    expect(heli.destroyedReason).toMatch(/water|ditch/i);
  });

  it('nothing leaks through the ground: a destroyed aircraft never ends up below the surface', () => {
    const heli = drop('scout', 20);
    expect(heli.destroyed).toBe(true);
    expect(heli.pos.y).toBeGreaterThan(0.1);
    expect(Number.isFinite(heli.pos.x + heli.pos.y + heli.pos.z)).toBe(true);
    expect(deg(0)).toBe(0);
  });
});
