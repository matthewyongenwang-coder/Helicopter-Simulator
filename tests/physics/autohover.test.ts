import { describe, expect, it } from 'vitest';
import { Warn } from '../../src/sim/types';
import { deg, headingDiff, hold, holdUntil, inHover, onGround, runUntil, settleTime, tap, tiltDeg } from './helpers';

/**
 * Fly into a steep bank with a fast sideways drift using only the keys:
 * hold D to at least `bank` degrees, then wait for the drift to build.
 */
function bankAndDrift(sim: ReturnType<typeof inHover>['sim'], bank: number, drift: number): void {
  holdUntil(sim, 'KeyD', () => deg(sim.heli.tel.roll) >= bank, 5);
  runUntil(sim, () => sim.heli.tel.groundSpeed >= drift, 10);
}

describe('autohover', () => {
  it('X from a steep tilt and a fast drift gives a level, motionless hover in under 2 seconds', () => {
    const { sim, heli } = inHover();
    bankAndDrift(sim, 30, 8);
    // The state it has to recover from.
    expect(tiltDeg(heli)).toBeGreaterThan(30);
    expect(heli.tel.groundSpeed).toBeGreaterThanOrEqual(8); // 8 m/s ≈ 16 kt sideways
    expect(heli.vel.y).toBeLessThan(-2); // and sinking, because nobody added collective

    tap(sim, 'KeyX');
    expect(heli.autohover.engaged).toBe(true);
    const t = settleTime(sim, 8);
    expect(t).toBeLessThan(2.0);
    // And it stays there.
    const p = heli.pos.clone();
    sim.run(5);
    expect(heli.pos.clone().sub(p).len()).toBeLessThan(0.3);
    expect(tiltDeg(heli)).toBeLessThan(0.5);
    expect(Math.abs(heli.tel.yawRate)).toBeLessThan(0.01);
  });

  it('stops by leaning against its own motion, then settles level', () => {
    const { sim, heli } = inHover();
    bankAndDrift(sim, 30, 8);
    expect(heli.vel.x).toBeGreaterThan(0); // drifting right, banked right
    tap(sim, 'KeyX');
    let maxOpposite = 0;
    sim.run(3, (s) => {
      // Lean of the rotor axis measured against the direction of travel.
      if (s.heli.vel.x > 0.5) maxOpposite = Math.max(maxOpposite, -deg(s.heli.tel.roll));
    });
    expect(maxOpposite).toBeGreaterThan(20); // it banked hard left to stop a rightward drift
    expect(tiltDeg(heli)).toBeLessThan(1);
  });

  it('holds altitude and heading from the moment it is switched on', () => {
    const { sim, heli } = inHover();
    tap(sim, 'KeyX');
    sim.run(2);
    const alt = heli.pos.y, hdg = heli.tel.heading;
    sim.run(20);
    expect(Math.abs(heli.pos.y - alt)).toBeLessThan(0.1);
    expect(Math.abs(headingDiff(heli.tel.heading, hdg))).toBeLessThan(0.3);
    expect(heli.autohover.mode).toBe('hold');
  });

  it('W: flies forward while held; on release it leans back, brakes and settles into a level hover', () => {
    const { sim, heli } = inHover();
    tap(sim, 'KeyX');
    sim.run(1);
    const alt = heli.pos.y, z0 = heli.pos.z;
    sim.keyDown('KeyW');
    sim.run(0.3);
    expect(deg(heli.tel.pitch)).toBeLessThan(-5); // the pilot is flying it: controls are not locked
    sim.run(3.7);
    expect(heli.vel.z).toBeLessThan(-15); // heading north: forward flight
    expect(deg(heli.tel.pitch)).toBeLessThan(-25);
    expect(Math.abs(heli.pos.y - alt)).toBeLessThan(1.5); // collective axis still held by autohover
    sim.keyUp('KeyW');

    let maxNoseUp = -90;
    const zRelease = heli.pos.z;
    let stopped = Infinity;
    const t0 = sim.time;
    sim.run(10, (s) => {
      maxNoseUp = Math.max(maxNoseUp, deg(s.heli.tel.pitch));
      if (stopped === Infinity && s.heli.vel.len() < 0.5 && tiltDeg(s.heli) < 3) stopped = s.time - t0;
    });
    expect(maxNoseUp).toBeGreaterThan(20); // leaned back against the motion
    expect(stopped).toBeLessThan(5);
    expect(tiltDeg(heli)).toBeLessThan(0.5);
    expect(heli.vel.len()).toBeLessThan(0.1);
    expect(heli.pos.z).toBeLessThan(zRelease); // it is holding the new position, not flying back
    expect(heli.pos.z).toBeLessThan(z0 - 40);
    const p = heli.pos.clone();
    sim.run(5);
    expect(heli.pos.clone().sub(p).len()).toBeLessThan(0.2);
  });

  it('A and D: slides sideways while held; on release it brakes and holds the new position', () => {
    for (const [key, sign] of [['KeyD', 1], ['KeyA', -1]] as const) {
      const { sim, heli } = inHover();
      tap(sim, 'KeyX');
      sim.run(1);
      hold(sim, key, 3);
      expect(heli.vel.x * sign).toBeGreaterThan(10);
      let maxAgainst = 0;
      sim.run(8, (s) => {
        maxAgainst = Math.max(maxAgainst, -sign * deg(s.heli.tel.roll));
      });
      expect(maxAgainst).toBeGreaterThan(20);
      expect(heli.vel.len()).toBeLessThan(0.1);
      expect(tiltDeg(heli)).toBeLessThan(0.5);
      expect(heli.pos.x * sign).toBeGreaterThan(15);
      const x = heli.pos.x;
      sim.run(4);
      expect(Math.abs(heli.pos.x - x)).toBeLessThan(0.2);
    }
  });

  it('Space and Shift: climbs or descends while held; on release it cancels vertical speed and holds the new altitude', () => {
    const { sim, heli } = inHover('medium', 120);
    tap(sim, 'KeyX');
    sim.run(1);
    const alt0 = heli.pos.y;
    hold(sim, 'Space', 2);
    expect(heli.vel.y).toBeGreaterThan(3);
    sim.run(2.5);
    expect(Math.abs(heli.vel.y)).toBeLessThan(0.3);
    const alt1 = heli.pos.y;
    expect(alt1).toBeGreaterThan(alt0 + 4);
    sim.run(6);
    expect(Math.abs(heli.pos.y - alt1)).toBeLessThan(0.4);

    hold(sim, 'ShiftLeft', 1);
    expect(heli.vel.y).toBeLessThan(-2);
    sim.run(3);
    expect(Math.abs(heli.vel.y)).toBeLessThan(0.3);
    const alt2 = heli.pos.y;
    expect(alt2).toBeLessThan(alt1 - 2);
    sim.run(6);
    expect(Math.abs(heli.pos.y - alt2)).toBeLessThan(0.4);
    expect(heli.vel.len()).toBeLessThan(0.1);
  });

  it('Q and E: turns while held; on release it stops the rotation and holds the new heading', () => {
    for (const [key, sign] of [['KeyE', 1], ['KeyQ', -1]] as const) {
      const { sim, heli } = inHover();
      tap(sim, 'KeyX');
      sim.run(1);
      const h0 = heli.tel.heading;
      hold(sim, key, 1.5);
      expect(heli.tel.yawRate * sign).toBeGreaterThan(0.6);
      sim.run(1.5);
      expect(Math.abs(heli.tel.yawRate)).toBeLessThan(0.02);
      const h1 = heli.tel.heading;
      expect(headingDiff(h1, h0) * sign).toBeGreaterThan(60);
      sim.run(5);
      expect(Math.abs(headingDiff(heli.tel.heading, h1))).toBeLessThan(0.5);
      expect(heli.vel.len()).toBeLessThan(0.2);
    }
  });

  it('switching it off leaves the aircraft exactly as it is', () => {
    const { sim, heli, env } = inHover();
    env.windState = { x: 15, z: 0, gust: 0 };
    tap(sim, 'KeyX');
    sim.run(12); // settled, leaning into a 30 kt wind
    const lever = heli.collective, trim = heli.pedalTrim;
    const tilt = tiltDeg(heli);
    expect(tilt).toBeGreaterThan(1);
    expect(heli.vel.len()).toBeLessThan(0.2);
    const q = heli.q.clone();
    tap(sim, 'KeyX');
    expect(heli.autohover.engaged).toBe(false);
    expect(heli.collective).toBe(lever);
    expect(heli.pedalTrim).toBe(trim);
    const dq = Math.abs(heli.q.x - q.x) + Math.abs(heli.q.y - q.y) + Math.abs(heli.q.z - q.z) + Math.abs(heli.q.w - q.w);
    expect(dq).toBeLessThan(1e-3);
    // No input is applied afterwards either: lever, trim and attitude stay put.
    sim.run(3);
    expect(heli.collective).toBe(lever);
    expect(heli.pedalTrim).toBe(trim);
    expect(Math.abs(tiltDeg(heli) - tilt)).toBeLessThan(0.1);
  });

  it('holds position against wind and turbulence', () => {
    const { sim, heli, env } = inHover();
    tap(sim, 'KeyX');
    sim.run(2);
    const p = heli.pos.clone();
    env.windState = { x: 9, z: -4, gust: 3.5 };
    let worst = 0, tiltSum = 0, n = 0;
    sim.run(30, (s) => {
      if (s.time > 12) {
        worst = Math.max(worst, Math.hypot(s.heli.pos.x - p.x, s.heli.pos.z - p.z));
        tiltSum += tiltDeg(s.heli);
        n++;
      }
    });
    expect(worst).toBeLessThan(2.5); // metres, in a 20 kt gusting wind
    expect(tiltSum / n).toBeGreaterThan(0.8); // it is leaning into the wind to do it
    expect(Math.abs(heli.pos.y - p.y)).toBeLessThan(1);

    // The same wind with autohover off carries the aircraft away.
    const free = inHover();
    free.env.windState = { x: 9, z: -4, gust: 3.5 };
    free.sim.run(20);
    expect(Math.hypot(free.heli.pos.x, free.heli.pos.z)).toBeGreaterThan(20);
  });

  it('works only with the engine running and rotor RPM in the green', () => {
    // Engine off on the ground: it arms but does nothing.
    const g = onGround();
    tap(g.sim, 'KeyX');
    g.sim.run(2);
    expect(g.heli.autohover.engaged).toBe(true);
    expect(g.heli.autohover.active).toBe(false);
    expect(g.heli.collective).toBe(0);

    // In flight, an engine failure takes it out as RPM decays.
    const { sim, heli } = inHover('medium', 400);
    tap(sim, 'KeyX');
    sim.run(2);
    expect(heli.autohover.active).toBe(true);
    heli.failEngine();
    sim.run(1);
    expect(heli.autohover.active).toBe(false);
    expect(heli.autohover.engaged).toBe(true); // stays switched on until X is pressed
    const lever = heli.collective;
    sim.run(2);
    expect(heli.collective).toBe(lever); // and commands nothing
    expect(heli.tel.warnings & Warn.AutohoverUnavailable).toBeTruthy();
  });

  it('recovers from a fast steep descent without settling into vortex ring state', () => {
    const { sim, heli } = inHover('medium', 600);
    hold(sim, 'ShiftLeft', 1.2);
    runUntil(sim, () => heli.vel.y < -11, 20);
    tap(sim, 'KeyX');
    const t = runUntil(sim, () => Math.abs(heli.vel.y) < 0.5 && heli.vel.len() < 1, 25);
    expect(t).toBeLessThan(25);
    sim.run(4);
    expect(heli.vel.len()).toBeLessThan(0.3);
    expect(heli.pos.y).toBeGreaterThan(350);
  });
});
