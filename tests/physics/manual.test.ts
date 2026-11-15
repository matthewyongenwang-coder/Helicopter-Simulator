import { describe, expect, it } from 'vitest';
import { AIRCRAFT } from '../../src/data/aircraft';
import { deg, headingDiff, hold, holdUntil, inHover, runUntil, tiltDeg } from './helpers';

const M = AIRCRAFT.medium;

describe('manual flight, autohover off', () => {
  it('a hands-off hover stays put: nothing moves the aircraft but thrust', () => {
    const { sim, heli } = inHover();
    const p0 = heli.pos.clone();
    sim.run(5);
    expect(heli.autohover.engaged).toBe(false);
    expect(heli.pos.clone().sub(p0).len()).toBeLessThan(0.3);
    expect(tiltDeg(heli)).toBeLessThan(0.1);
  });

  it('W with no collective change: the nose drops, it moves forward and sinks; adding collective restores altitude', () => {
    const { sim, heli } = inHover();
    const alt0 = heli.pos.y, lever0 = heli.collective;
    hold(sim, 'KeyW', 0.7);
    sim.run(3);
    expect(heli.collective).toBe(lever0); // lever untouched
    expect(deg(heli.tel.pitch)).toBeLessThan(-20); // nose down
    expect(heli.vel.z).toBeLessThan(-8); // heading north = −Z: moving forward
    expect(heli.vel.y).toBeLessThan(-1.5); // sinking: part of the thrust now points forward
    expect(heli.pos.y).toBeLessThan(alt0 - 2.5);

    // Raise the lever until the sink is reversed, then let it climb back.
    const held = holdUntil(sim, 'Space', () => heli.vel.y > 1, 8);
    expect(held).toBeLessThan(8);
    expect(heli.collective).toBeGreaterThan(lever0);
    const back = runUntil(sim, () => heli.pos.y >= alt0, 30);
    expect(back).toBeLessThan(30);
    expect(tiltDeg(heli)).toBeGreaterThan(20); // still tilted: only thrust changed
  });

  it('releasing the keys leaves the aircraft tilted and still accelerating', () => {
    const { sim, heli } = inHover('medium', 300);
    hold(sim, 'KeyW', 0.45);
    hold(sim, 'KeyD', 0.3);
    sim.run(0.8); // let the rate response die away
    const tilt0 = tiltDeg(heli), pitch0 = deg(heli.tel.pitch);
    const v0 = heli.tel.groundSpeed;
    expect(tilt0).toBeGreaterThan(15);
    sim.run(3);
    const v1 = heli.tel.groundSpeed;
    sim.run(1);
    const v2 = heli.tel.groundSpeed;
    // No self-levelling of any kind.
    expect(Math.abs(tiltDeg(heli) - tilt0)).toBeLessThan(0.3);
    expect(Math.abs(deg(heli.tel.pitch) - pitch0)).toBeLessThan(1.5);
    // Still speeding up, four seconds after the keys were released.
    expect(v1 - v0).toBeGreaterThan(8);
    expect(v2 - v1).toBeGreaterThan(2);
  });

  it('each cyclic and pedal key gives a steady rate while held and a fixed attitude once released', () => {
    // [key, axis, expected rate in deg/s]. Pitch is positive nose up, roll positive right, heading clockwise.
    const cases: [string, 'pitch' | 'roll' | 'heading', number][] = [
      ['KeyW', 'pitch', -M.handling.pitchRate],
      ['KeyS', 'pitch', M.handling.pitchRate],
      ['KeyD', 'roll', M.handling.rollRate],
      ['KeyA', 'roll', -M.handling.rollRate],
      ['KeyE', 'heading', M.handling.yawRate],
      ['KeyQ', 'heading', -M.handling.yawRate],
    ];
    for (const [key, axis, expected] of cases) {
      const { sim, heli } = inHover();
      // Signed change of the axis angle in degrees, safe across the 0/360 heading wrap.
      const change = (from: number) => headingDiff(heli.tel[axis], from);
      sim.keyDown(key);
      sim.run(0.5);
      const a0 = heli.tel[axis];
      sim.run(0.25);
      const rate = change(a0) / 0.25;
      sim.keyUp(key);
      expect(rate / expected, `${key} rate`).toBeGreaterThan(0.85);
      expect(rate / expected, `${key} rate`).toBeLessThan(1.15);
      // Released: the rotation stops and the new attitude is kept.
      sim.run(1.0);
      const b0 = heli.tel[axis];
      sim.run(1.5);
      expect(Math.abs(change(b0)), `${key} drift after release`).toBeLessThan(axis === 'heading' ? 2.5 : 0.5);
    }
  });

  it('tilt decides the direction of travel: A slides left, D slides right, S backs up', () => {
    const run = (key: string) => {
      const { sim, heli } = inHover();
      hold(sim, key, 0.4);
      sim.run(3);
      return heli;
    };
    expect(run('KeyA').vel.x).toBeLessThan(-4);
    expect(run('KeyD').vel.x).toBeGreaterThan(4);
    expect(run('KeyS').vel.z).toBeGreaterThan(4);
    expect(run('KeyW').vel.z).toBeLessThan(-4);
  });

  it('collective is a persistent lever', () => {
    const { sim, heli } = inHover('medium', 400);
    const lever0 = heli.collective;
    hold(sim, 'ShiftLeft', 0.5);
    const lever1 = heli.collective;
    expect(lever1).toBeCloseTo(lever0 - 0.5 * M.handling.collectiveRate, 2);
    sim.run(5);
    expect(heli.collective).toBe(lever1);
    hold(sim, 'Space', 0.25);
    expect(heli.collective).toBeCloseTo(lever1 + 0.25 * M.handling.collectiveRate, 2);
  });

  it('anti-torque: raising collective yaws the nose right until the pilot corrects with Q', () => {
    const { sim, heli } = inHover('medium', 30);
    const h0 = heli.tel.heading;
    sim.run(3);
    const baseline = headingDiff(heli.tel.heading, h0); // hands-off drift
    expect(Math.abs(baseline)).toBeLessThan(2);

    hold(sim, 'Space', 0.6);
    const h1 = heli.tel.heading;
    sim.run(3);
    const swing = headingDiff(heli.tel.heading, h1);
    expect(swing).toBeGreaterThan(6); // nose swings right under the extra torque
    expect(heli.tel.yawRate).toBeGreaterThan(0);

    // Left pedal overcomes it.
    sim.keyDown('KeyQ');
    sim.run(1);
    expect(heli.tel.yawRate).toBeLessThan(0);
    sim.keyUp('KeyQ');
  });

  it('lowering collective yaws the other way', () => {
    const { sim, heli } = inHover('medium', 300);
    hold(sim, 'ShiftLeft', 0.6);
    const h1 = heli.tel.heading;
    sim.run(2);
    expect(headingDiff(heli.tel.heading, h1)).toBeLessThan(-3);
  });
});
