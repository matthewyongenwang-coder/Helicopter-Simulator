import { describe, expect, it } from 'vitest';
import { AIRCRAFT } from '../../src/data/aircraft';
import { TUNING } from '../../src/data/tuning';
import { deriveAircraft } from '../../src/sim/derive';
import { KTS } from '../../src/sim/math';
import type { Simulation } from '../../src/sim/simulation';
import { Warn } from '../../src/sim/types';
import { deg, hold, holdUntil, inHover, onGround, runUntil, startEngine, tap } from './helpers';

const AC = deriveAircraft(AIRCRAFT.medium);

/** Mean of a telemetry value over a time span. */
function mean(sim: Simulation, seconds: number, f: () => number): number {
  let sum = 0, n = 0;
  sim.run(seconds, () => {
    sum += f();
    n++;
  });
  return sum / n;
}

/**
 * A pilot that only presses keys: holds a pitch attitude with W/S, wings level with
 * A/D and altitude with Space/Shift. Used to fly steady level flight for measurements.
 */
function flyLevel(sim: Simulation, pitchDeg: () => number, alt: number, seconds: number, each?: () => void): void {
  const h = sim.heli;
  const set = (code: string, on: boolean) => (on ? sim.keyDown(code) : sim.keyUp(code));
  sim.run(seconds, () => {
    const pitchErr = pitchDeg() - deg(h.tel.pitch);
    set('KeyS', pitchErr > 0.6);
    set('KeyW', pitchErr < -0.6);
    const roll = deg(h.tel.roll);
    set('KeyA', roll > 0.8);
    set('KeyD', roll < -0.8);
    const vyWant = Math.max(-6, Math.min(6, 0.6 * (alt - h.pos.y)));
    set('Space', h.vel.y < vyWant - 0.25);
    set('ShiftLeft', h.vel.y > vyWant + 0.25);
    if (each) each();
  });
  for (const k of ['KeyS', 'KeyW', 'KeyA', 'KeyD', 'Space', 'ShiftLeft']) sim.keyUp(k);
}

describe('rotor aerodynamics', () => {
  it('thrust follows collective with a short lag, not instantly', () => {
    const { sim, heli } = inHover();
    const t0 = heli.tel.thrust;
    sim.keyDown('Space');
    sim.run(0.05);
    const early = heli.tel.thrust - t0;
    sim.run(0.45);
    sim.keyUp('Space');
    const late = heli.tel.thrust - t0;
    expect(late).toBeGreaterThan(0.1 * t0);
    expect(early).toBeLessThan(0.1 * late); // the first 50 ms shows little of it
    sim.run(1);
    expect(heli.vel.y).toBeGreaterThan(1);
  });

  it('ground effect: hovering close to the surface takes less power', () => {
    const torqueAt = (cgHeight: number) => {
      const { sim, heli } = inHover('medium', cgHeight);
      tap(sim, 'KeyX');
      sim.run(6);
      return { torque: mean(sim, 3, () => heli.tel.torque), ige: heli.tel.inGroundEffect };
    };
    const low = torqueAt(AC.restHeight + 1.5);
    const high = torqueAt(80);
    expect(low.torque).toBeLessThan(high.torque * 0.92);
    expect(low.ige).toBeGreaterThan(0.5);
    expect(high.ige).toBeLessThan(0.02);
  });

  it('translational lift: airflow across the disc at about 20 kt adds lift at the same collective', () => {
    const { sim, heli, env } = inHover();
    sim.run(2);
    expect(Math.abs(heli.vel.y)).toBeLessThan(0.1);
    const lever = heli.collective;
    env.windState = { x: 0, z: 10.5, gust: 0 }; // a 20 kt headwind arrives
    sim.run(2.5);
    expect(heli.collective).toBe(lever);
    expect(heli.vel.y).toBeGreaterThan(0.6); // it balloons upward
    expect(heli.tel.translationalLift).toBeGreaterThan(0.1);
    // Drag from the wind: the aircraft is also being carried downwind.
    expect(heli.vel.z).toBeGreaterThan(0.05);
  });

  it('level flight needs less power at 60 kt than in the hover', () => {
    const { sim, heli } = inHover('medium', 200, { speed: 60 * KTS });
    flyLevel(sim, () => -3, 200, 20);
    let torque = 0, speed = 0, n = 0;
    flyLevel(sim, () => -3, 200, 10, () => {
      torque += heli.tel.torque;
      speed += heli.tel.airspeed;
      n++;
    });
    expect(speed / n).toBeGreaterThan(20);
    expect(torque / n).toBeLessThan(0.85 * AC.computed.hoverPowerFraction);
  });

  it('vortex ring state: a steep powered descent loses thrust, and airspeed is the way out', () => {
    const { sim, heli } = inHover('medium', 900);
    hold(sim, 'ShiftLeft', 0.9);
    runUntil(sim, () => heli.vel.y < -8, 20);
    // Pull the lever all the way up. In clear air this would climb hard.
    hold(sim, 'Space', 2.5);
    expect(heli.collective).toBe(1);
    let maxRing = 0, warned = false;
    sim.run(2, () => {
      maxRing = Math.max(maxRing, heli.tel.vortexRing);
      if (heli.tel.warnings & Warn.VortexRing) warned = true;
    });
    expect(maxRing).toBeGreaterThan(0.6);
    expect(warned).toBe(true);
    expect(heli.vel.y).toBeLessThan(-6); // full collective and still falling
    expect(heli.tel.groundSpeed).toBeLessThan(3);

    // Nose down to pick up speed and the ring clears; level off again and it climbs away.
    hold(sim, 'KeyW', 0.8);
    const clear = runUntil(sim, () => heli.tel.vortexRing < 0.02 && heli.tel.groundSpeed > 14, 8);
    expect(clear).toBeLessThan(4);
    holdUntil(sim, 'KeyS', () => deg(heli.tel.pitch) > -6, 3);
    const t = runUntil(sim, () => heli.vel.y > 1, 12);
    expect(t).toBeLessThan(12);
    expect(heli.tel.vortexRing).toBe(0);
  });

  it('retreating-blade stall: past VNE it loses lift, rolls left and pitches up', () => {
    const { sim, heli } = inHover('medium', 500, { speed: AC.vne + 14 }, 0.1);
    expect(heli.tel.bladeStall).toBeGreaterThan(0.2);
    expect(heli.tel.warnings & Warn.BladeStall).toBeTruthy();
    expect(heli.tel.warnings & Warn.Overspeed).toBeTruthy();
    const roll0 = deg(heli.tel.roll), pitch0 = deg(heli.tel.pitch);
    sim.run(1.5);
    expect(deg(heli.tel.roll)).toBeLessThan(roll0 - 4);
    expect(deg(heli.tel.pitch)).toBeGreaterThan(pitch0 + 2);
    // Below VNE there is none.
    const slow = inHover('medium', 500, { speed: 0.8 * AC.vne }, 0.1);
    expect(slow.heli.tel.bladeStall).toBe(0);
    slow.sim.run(1.5);
    expect(Math.abs(deg(slow.heli.tel.roll))).toBeLessThan(0.5);
  });

  it('top speed in level flight at rated power matches the listed figure', () => {
    const { sim, heli } = inHover('medium', 150, { speed: 0.92 * AC.topSpeed });
    // Hold the nose-down attitude that keeps torque at 100 % and see where speed settles.
    let pitch = -8;
    flyLevel(sim, () => pitch, 150, 60, () => {
      pitch += (heli.tel.torque - 1.0) * 0.02; // too much torque → ease the nose up
      pitch = Math.max(-25, Math.min(0, pitch));
    });
    let speed = 0, torque = 0, n = 0;
    flyLevel(sim, () => pitch, 150, 15, () => {
      pitch += (heli.tel.torque - 1.0) * 0.02;
      pitch = Math.max(-25, Math.min(0, pitch));
      speed += heli.tel.airspeed;
      torque += heli.tel.torque;
      n++;
    });
    expect(torque / n).toBeGreaterThan(0.93);
    expect(torque / n).toBeLessThan(1.07);
    expect(speed / n / AC.topSpeed).toBeGreaterThan(0.93);
    expect(speed / n / AC.topSpeed).toBeLessThan(1.07);
  });
});

describe('engine, power and weight limits', () => {
  it('overpitching droops the rotor: the engine cannot supply unlimited power', () => {
    const { sim, heli } = inHover('medium', 60, { payload: 3000 }); // close to max gross weight
    sim.run(2);
    expect(heli.rotorN).toBeGreaterThan(0.99);
    hold(sim, 'Space', 2);
    expect(heli.collective).toBe(1);
    let minRpm = 1, warned = false, maxTorque = 0;
    sim.run(6, () => {
      minRpm = Math.min(minRpm, heli.rotorN);
      maxTorque = Math.max(maxTorque, heli.tel.torque);
      if (heli.tel.warnings & Warn.LowRotorRpm) warned = true;
    });
    expect(maxTorque).toBeGreaterThan(1.1); // the engine is giving everything it has
    expect(maxTorque).toBeLessThanOrEqual(TUNING.engine.torqueLimit + 1e-6);
    expect(minRpm).toBeLessThan(TUNING.engine.greenMin); // and the rotor still slows down
    expect(warned).toBe(true);
    expect(heli.tel.warnings & Warn.OverTorque).toBeTruthy();
  });

  it('cannot lift off above its maximum gross weight', () => {
    const over = onGround('medium', { payload: 7500 });
    expect(over.heli.mass()).toBeGreaterThan(AIRCRAFT.medium.mass.maxTakeoff * 1.3);
    startEngine(over.sim);
    hold(over.sim, 'Space', 4);
    let maxAlt = 0;
    over.sim.run(12, () => (maxAlt = Math.max(maxAlt, over.heli.tel.radarAlt)));
    expect(over.heli.collective).toBe(1);
    expect(maxAlt).toBeLessThan(0.05);
    expect(over.heli.tel.warnings & Warn.Overweight).toBeTruthy();

    const std = onGround('medium');
    startEngine(std.sim);
    hold(std.sim, 'Space', 4);
    std.sim.run(6);
    expect(std.heli.tel.radarAlt).toBeGreaterThan(30);
  });

  it('a lighter aircraft climbs faster at the same collective', () => {
    const climbAfter = (payload: number, fuelFraction: number) => {
      const { sim, heli } = onGround('medium', { payload, fuelFraction });
      startEngine(sim);
      hold(sim, 'Space', 2.2);
      sim.run(6);
      return heli.vel.y;
    };
    const light = climbAfter(0, 0.3);
    const heavy = climbAfter(2400, 1);
    expect(heavy).toBeGreaterThan(0.5);
    expect(light).toBeGreaterThan(heavy + 2);
  });

  it('burns fuel in proportion to power, and the aircraft gets lighter', () => {
    const { sim, heli } = inHover();
    const m0 = heli.mass(), f0 = heli.fuel;
    sim.run(120);
    const burned = f0 - heli.fuel;
    expect(m0 - heli.mass()).toBeCloseTo(burned, 6);
    // 560 kg/h at rated power; the hover sits at roughly 70 % torque.
    expect(burned).toBeGreaterThan(11);
    expect(burned).toBeLessThan(19);
    // Idling on the ground burns far less.
    const g = onGround();
    startEngine(g.sim);
    const gf = g.heli.fuel;
    g.sim.run(120);
    expect(gf - g.heli.fuel).toBeLessThan(0.6 * burned);
    expect(gf - g.heli.fuel).toBeGreaterThan(3);
  });

  it('runs out of fuel: the engine quits and the warning shows', () => {
    const { sim, heli } = inHover('medium', 500, { fuelFraction: 0.002 });
    const t = runUntil(sim, () => heli.engine === 'failed', 60);
    expect(t).toBeLessThan(60);
    expect(heli.fuel).toBe(0);
    sim.run(0.5);
    expect(heli.tel.warnings & Warn.EngineOut).toBeTruthy();
    expect(heli.tel.torque).toBeLessThan(0.6);
  });
});

describe('autorotation', () => {
  it('with the engine out and the lever lowered, the airflow keeps the rotor turning', () => {
    const { sim, heli } = inHover('medium', 1200, { speed: 36 });
    tap(sim, 'KeyJ'); // engine off in flight
    expect(heli.engine).toBe('off');
    hold(sim, 'ShiftLeft', 2.6);
    expect(heli.collective).toBe(0);
    sim.run(6);
    let minRpm = 9, maxRpm = 0, sink = 0, n = 0;
    sim.run(8, () => {
      minRpm = Math.min(minRpm, heli.rotorN);
      maxRpm = Math.max(maxRpm, heli.rotorN);
      sink += -heli.vel.y;
      n++;
    });
    expect(heli.tel.torque).toBeLessThan(0.01); // no engine torque at all
    expect(minRpm).toBeGreaterThan(0.85);
    expect(maxRpm).toBeLessThan(1.2);
    expect(sink / n).toBeGreaterThan(5);
    expect(sink / n).toBeLessThan(22);
    expect(heli.tel.warnings & Warn.EngineOut).toBeTruthy();

    // Raising the lever trades rotor speed for lift: the descent slows as RPM falls.
    const sinkBefore = -heli.vel.y, rpmBefore = heli.rotorN;
    hold(sim, 'Space', 1.6);
    expect(-heli.vel.y).toBeLessThan(sinkBefore - 2);
    expect(heli.rotorN).toBeLessThan(rpmBefore - 0.03);
  });

  it('with the lever left up, rotor RPM decays and is not recoverable in time', () => {
    const { sim, heli } = inHover('medium', 1200);
    tap(sim, 'KeyJ');
    sim.run(4);
    expect(heli.rotorN).toBeLessThan(0.75);
    expect(heli.tel.warnings & Warn.LowRotorRpm).toBeTruthy();
  });

  it('losing engine torque yaws the nose left (the pedal trim is now too much)', () => {
    const { sim, heli } = inHover('medium', 800);
    tap(sim, 'KeyJ');
    sim.run(1.5);
    expect(heli.tel.yawRate).toBeLessThan(-0.05);
  });
});

describe('turbulence', () => {
  it('gusts disturb attitude and position; calm air does not', () => {
    const calm = inHover();
    calm.sim.run(15);
    const gusty = inHover();
    gusty.env.windState = { x: 0, z: 0, gust: 5 };
    let maxTilt = 0;
    gusty.sim.run(15, (s) => {
      const up = (s.heli as unknown as { up: { y: number } }).up.y;
      maxTilt = Math.max(maxTilt, deg(Math.acos(Math.min(1, up))));
    });
    expect(maxTilt).toBeGreaterThan(0.5);
    expect(gusty.heli.pos.clone().sub(calm.heli.pos).len()).toBeGreaterThan(1);
  });

  it('is deterministic: the same script gives the same flight', () => {
    const fly = () => {
      const r = inHover();
      r.env.windState = { x: 4, z: 2, gust: 3 };
      holdUntil(r.sim, 'KeyW', () => false, 0.4);
      r.sim.run(8);
      return r.heli.pos.clone();
    };
    const a = fly(), b = fly();
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(b.y);
    expect(a.z).toBe(b.z);
  });
});
