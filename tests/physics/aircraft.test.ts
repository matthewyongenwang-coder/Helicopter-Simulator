import { describe, expect, it } from 'vitest';
import { AIRCRAFT, AIRCRAFT_ORDER } from '../../src/data/aircraft';
import { TUNING } from '../../src/data/tuning';
import { deriveAircraft } from '../../src/sim/derive';
import { KTS } from '../../src/sim/math';
import { deg, hold, holdUntil, inHover, onGround, runUntil, settleTime, startEngine, tap, tiltDeg } from './helpers';

/** Run the same key script in every aircraft and collect one number from each. */
function each<T>(f: (id: string) => T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const id of AIRCRAFT_ORDER) out[id] = f(id);
  return out;
}

/** Every pair of values differs by at least `margin` (relative). */
function allDistinct(v: Record<string, number>, margin: number): boolean {
  const xs = Object.values(v);
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      if (Math.abs(xs[i] - xs[j]) < margin * Math.max(Math.abs(xs[i]), Math.abs(xs[j]))) return false;
    }
  }
  return true;
}

describe('the seven aircraft', () => {
  it('have distinct specifications', () => {
    expect(AIRCRAFT_ORDER.length).toBe(7);
    const mass = each((id) => deriveAircraft(AIRCRAFT[id]).stdMass);
    const power = each((id) => AIRCRAFT[id].engine.powerKW);
    const rotor = each((id) => AIRCRAFT[id].rotor.diameter);
    expect(allDistinct(mass, 0.005)).toBe(true);
    expect(new Set(Object.values(power)).size).toBe(7);
    expect(new Set(Object.values(rotor)).size).toBeGreaterThanOrEqual(5);
    expect(mass.heavy).toBeGreaterThan(3 * mass.medium);
    expect(mass.scout).toBeLessThan(mass.utility / 2.5);
    for (const id of AIRCRAFT_ORDER) {
      const d = AIRCRAFT[id], ac = deriveAircraft(d);
      expect(ac.stdMass, id).toBeLessThanOrEqual(d.mass.maxTakeoff);
      // Hovers with power in hand at standard weight, and can still hover at max gross.
      expect(ac.computed.hoverPowerFraction, id).toBeLessThan(0.82);
      expect(ac.computed.hoverPowerFraction, id).toBeGreaterThan(0.4);
      expect(ac.computed.maxClimb, id).toBeGreaterThan(5);
      expect(ac.computed.endurance, id).toBeGreaterThan(1.5);
    }
  });

  it('the same pitch input gives measurably different results in each', () => {
    // Hold W for 0.5 s from a hover, then look 2.5 s later.
    const pitch = each((id) => {
      const { sim, heli } = inHover(id);
      hold(sim, 'KeyW', 0.5);
      sim.run(0.6);
      return -deg(heli.tel.pitch);
    });
    const speed = each((id) => {
      const { sim, heli } = inHover(id);
      hold(sim, 'KeyW', 0.5);
      sim.run(2.5);
      return heli.tel.groundSpeed;
    });
    expect(allDistinct(pitch, 0.04)).toBe(true);
    // Scout the most nimble, heavy-lift the most sluggish, with real separation between them.
    for (const id of AIRCRAFT_ORDER) {
      if (id !== 'scout') expect(pitch.scout).toBeGreaterThan(pitch[id] * 1.15);
      if (id !== 'heavy') expect(pitch.heavy).toBeLessThan(pitch[id] * 0.6);
    }
    expect(pitch.scout).toBeGreaterThan(3.5 * pitch.heavy);
    expect(speed.scout).toBeGreaterThan(2.5 * speed.heavy);
  });

  it('roll, yaw and collective also respond differently', () => {
    const roll = each((id) => {
      const { sim, heli } = inHover(id);
      hold(sim, 'KeyD', 0.5);
      sim.run(0.6);
      return deg(heli.tel.roll);
    });
    const yaw = each((id) => {
      const { sim, heli } = inHover(id);
      hold(sim, 'KeyE', 1);
      return deg(heli.tel.heading);
    });
    const climb = each((id) => {
      const { sim, heli } = inHover(id);
      hold(sim, 'Space', 0.5);
      sim.run(2.5);
      return heli.vel.y;
    });
    expect(allDistinct(roll, 0.03)).toBe(true);
    expect(allDistinct(yaw, 0.03)).toBe(true);
    expect(roll.scout).toBeGreaterThan(3.5 * roll.heavy);
    expect(yaw.scout).toBeGreaterThan(3.5 * yaw.heavy);
    // The lever moves at different rates and buys different climb.
    expect(Math.max(...Object.values(climb)) - Math.min(...Object.values(climb))).toBeGreaterThan(1.5);
    for (const id of AIRCRAFT_ORDER) expect(climb[id], id).toBeGreaterThan(1);
  });

  it('the scout is easy to over-correct: the same tap swings it much further than the heavy', () => {
    // A quarter-second tap of A then D. A sluggish aircraft has barely moved; a twitchy one has banked hard.
    const swing = each((id) => {
      const { sim, heli } = inHover(id);
      let peak = 0;
      sim.keyDown('KeyA');
      sim.run(0.25, () => (peak = Math.max(peak, Math.abs(deg(heli.tel.roll)))));
      sim.keyUp('KeyA');
      sim.run(0.5, () => (peak = Math.max(peak, Math.abs(deg(heli.tel.roll)))));
      return peak;
    });
    expect(swing.scout).toBeGreaterThan(15);
    expect(swing.heavy).toBeLessThan(5);
    expect(swing.attack).toBeGreaterThan(swing.medium);
  });

  it('each starts, spools up in its own time and lifts off', () => {
    const spool = each((id) => {
      const { sim, heli } = onGround(id);
      const t = startEngine(sim);
      holdUntil(sim, 'Space', () => heli.tel.radarAlt > 2, 12);
      expect(heli.tel.radarAlt, id).toBeGreaterThan(2);
      expect(heli.rotorN, id).toBeGreaterThanOrEqual(TUNING.engine.greenMin - 0.03);
      expect(heli.health, id).toBe(1);
      return t;
    });
    for (const id of AIRCRAFT_ORDER) {
      expect(spool[id], id).toBeGreaterThan(10);
      expect(spool[id], id).toBeLessThan(22);
    }
  });

  it('none can lift off before the green, even empty with Space held', () => {
    for (const id of AIRCRAFT_ORDER) {
      const { sim, heli } = onGround(id, { fuelFraction: 0.1, payload: 0 });
      tap(sim, 'KeyJ');
      let maxRadar = 0;
      sim.keyDown('Space');
      sim.run(35, () => (maxRadar = Math.max(maxRadar, heli.tel.radarAlt)));
      sim.keyUp('Space');
      expect(maxRadar, id).toBeLessThan(0.01);
      expect(heli.rotorN, id).toBeLessThan(TUNING.engine.greenMin);
    }
  });

  it('autohover works on all of them and settles faster on the light ones', () => {
    const settle = each((id) => {
      const { sim, heli } = inHover(id);
      holdUntil(sim, 'KeyD', () => deg(heli.tel.roll) >= 30, 6);
      runUntil(sim, () => heli.tel.groundSpeed >= 8, 12);
      expect(tiltDeg(heli), id).toBeGreaterThan(30);
      tap(sim, 'KeyX');
      const t = settleTime(sim, 10);
      // And it holds.
      const p = heli.pos.clone();
      sim.run(4);
      expect(heli.pos.clone().sub(p).len(), id).toBeLessThan(0.4);
      return t;
    });
    for (const id of AIRCRAFT_ORDER) expect(settle[id], id).toBeLessThan(id === 'heavy' ? 3.0 : 2.0);
    expect(settle.scout).toBeLessThan(settle.medium - 0.2);
    expect(settle.scout).toBeLessThan(settle.utility);
    expect(settle.heavy).toBeGreaterThan(settle.medium + 0.5);
    expect(settle.heavy).toBeGreaterThan(settle.utility);
  });

  it('autohover brakes and holds after a W press in every aircraft', () => {
    for (const id of AIRCRAFT_ORDER) {
      const { sim, heli } = inHover(id);
      tap(sim, 'KeyX');
      sim.run(1);
      hold(sim, 'KeyW', 3);
      expect(heli.tel.groundSpeed, id).toBeGreaterThan(2);
      sim.run(9);
      expect(heli.vel.len(), id).toBeLessThan(0.2);
      expect(tiltDeg(heli), id).toBeLessThan(1);
    }
  });

  it('listed top speeds are reached at rated power in level flight, within a few percent', () => {
    for (const id of AIRCRAFT_ORDER) {
      const ac = deriveAircraft(AIRCRAFT[id]);
      // The drag area was sized so level flight at the listed top speed needs exactly rated power.
      expect(ac.topSpeed / KTS, id).toBeCloseTo(AIRCRAFT[id].perf.topSpeedKts, 6);
      expect(ac.fFwd, id).toBeGreaterThan(0.3);
      expect(ac.fFwd, id).toBeLessThan(30);
      expect(ac.vne, id).toBeGreaterThan(ac.topSpeed);
    }
  });

  it('damage tolerance differs: the same hard landing hurts the scout more than the attack helicopter', () => {
    const health = each((id) => {
      const { sim, heli } = onGround(id);
      heli.pos.y += 0.03;
      heli.vel.y = -5.5;
      sim.run(4);
      return heli.health;
    });
    expect(health.attack).toBeGreaterThan(health.scout + 0.1);
    expect(health.attack).toBeGreaterThan(health.utility);
    expect(health.scout).toBeLessThan(1);
    expect(allDistinct({ a: health.scout, b: health.attack, c: health.medium }, 0.01)).toBe(true);
  });

  it('fuel capacity and burn differ', () => {
    const burn = each((id) => {
      const { sim, heli } = inHover(id);
      const f = heli.fuel;
      sim.run(60);
      return f - heli.fuel;
    });
    expect(allDistinct(burn, 0.02)).toBe(true);
    expect(burn.heavy).toBeGreaterThan(8 * burn.scout);
  });
});
