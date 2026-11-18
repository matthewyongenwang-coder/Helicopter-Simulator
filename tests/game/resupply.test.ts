import { describe, expect, it } from 'vitest';
import { AIRCRAFT } from '../../src/data/aircraft';
import { LOADOUTS } from '../../src/data/weapons';
import { Combat } from '../../src/game/combat';
import { Resupply } from '../../src/game/resupply';
import { FlatEnvironment } from '../../src/sim/environment';
import { Simulation } from '../../src/sim/simulation';
import { rng } from '../../src/world/rng';
import { World } from '../../src/world/world';

const world = new World(424242);

/** An attack helicopter, battered, dry and empty, at a supply point `offset` metres from where it sits. */
function rig(offset = 0, airborne = false) {
  const sim = new Simulation(AIRCRAFT.attack, new FlatEnvironment(), { x: 0, y: airborne ? 12 : 0, z: 0, airborne });
  const heli = sim.heli;
  const combat = new Combat(world, { hit: () => {} }, rng(3));
  combat.arm('attack');
  combat.gunAmmo = 0;
  combat.missilesLeft = 0;
  combat.flaresLeft = 0;
  heli.health = 0.3;
  heli.tailRotorOk = false;
  heli.fuel = 20;
  const supply = new Resupply(world);
  supply.setHome(offset, 0, 0, 0);
  const run = (seconds: number) => {
    const events: string[] = [];
    for (let t = 0; t < seconds; t += 1 / 30) {
      sim.run(1 / 30);
      supply.update(1 / 30, heli, combat);
      events.push(...supply.takeEvents().map((e) => e.type));
    }
    return events;
  };
  return { sim, heli, combat, supply, run };
}

describe('resupply', () => {
  it('a landed aircraft inside the zone is repaired, refuelled and rearmed, a little at a time', () => {
    const { heli, combat, supply, run } = rig(8);
    run(3);
    expect(supply.status.serving).toBe(true);
    expect(supply.status.repairing && supply.status.rearming && supply.status.refuelling).toBe(true);
    // Partway: healing, not healed.
    expect(heli.health).toBeGreaterThan(0.3);
    expect(heli.health).toBeLessThan(0.6);
    expect(combat.gunAmmo).toBeGreaterThan(0);
    expect(combat.gunAmmo).toBeLessThan(LOADOUTS.attack.gun!.ammo);
    const events = run(30);
    expect(heli.health).toBe(1);
    expect(heli.tailRotorOk).toBe(true);
    expect(heli.fuel).toBeCloseTo(heli.fuelLimit(), 3);
    expect(heli.mass()).toBeLessThanOrEqual(AIRCRAFT.attack.mass.maxTakeoff + 1e-6);
    expect(combat.fullyArmed).toBe(true);
    expect(combat.missilesLeft).toBe(LOADOUTS.attack.missile!.rails.length);
    expect(combat.flaresLeft).toBe(LOADOUTS.attack.flares);
    expect(supply.status.progress).toBe(1);
    expect(events).toContain('complete');
  });

  it('nothing happens outside the zone or in the air', () => {
    for (const r of [rig(200), rig(0, true)]) {
      r.run(6);
      expect(r.supply.status.serving).toBe(false);
      expect(r.heli.health).toBe(0.3);
      expect(r.combat.gunAmmo).toBe(0);
    }
  });

  it('missiles go back on the rails in firing order', () => {
    const { combat, run } = rig(0);
    run(2.5);
    const n = combat.missilesLeft;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(LOADOUTS.attack.missile!.rails.length);
  });
});
