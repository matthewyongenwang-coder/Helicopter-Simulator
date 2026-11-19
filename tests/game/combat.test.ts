import { describe, expect, it } from 'vitest';
import { COMPOUNDS, ENEMY, LOADOUTS } from '../../src/data/weapons';
import { Combat, compoundHealth, type CombatEvent, type CombatInput, type PlayerState } from '../../src/game/combat';
import { compoundsNear, PART_TYPES, type CompoundSite } from '../../src/world/compounds';
import { rng } from '../../src/world/rng';
import { World } from '../../src/world/world';

const world = new World(424242);
// A compound with a SAM site.
const site = compoundsNear(world, 0, 0, 30000).find((s) => s.parts.some((p) => PART_TYPES[p.kind].weapon === 'sam')) as CompoundSite;

/** Hovering `dist` metres south of the compound and `alt` above it, nose to the north. */
function player(dist: number, alt: number): PlayerState {
  return { x: site.x, y: site.y + alt, z: site.z + dist, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1, radius: 4, agl: alt, alive: true, fragility: 0.8 };
}

function rayTo(p: PlayerState, x: number, y: number, z: number): CombatInput['ray'] {
  const dx = x - p.x, dy = y - p.y - 3, dz = z - p.z;
  const l = Math.hypot(dx, dy, dz);
  return { ox: p.x, oy: p.y + 3, oz: p.z, dx: dx / l, dy: dy / l, dz: dz / l };
}

function setup(dist: number, alt: number) {
  const hits: number[] = [];
  const combat = new Combat(world, { hit: (a) => hits.push(a) }, rng(7));
  combat.home = { x: site.x + 50000, z: site.z };
  combat.arm('attack');
  return { combat, p: player(dist, alt), hits };
}

function run(combat: Combat, p: PlayerState, seconds: number, input: (t: number) => CombatInput, each?: (e: CombatEvent[]) => void): CombatEvent[] {
  const all: CombatEvent[] = [];
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    combat.update(dt, p, input(t), true);
    const e = combat.takeEvents();
    all.push(...e);
    each?.(e);
  }
  return all;
}

describe('combat', () => {
  it('finds the compound and aims at what is under the reticle', () => {
    const { combat, p } = setup(900, 120);
    const cmd = site.parts[0];
    run(combat, p, 0.2, () => ({ gun: false, missile: false, flares: false, ray: rayTo(p, cmd.x, cmd.y + 2, cmd.z) }));
    expect(combat.active.some((c) => c.site.id === site.id)).toBe(true);
    expect(combat.aim.compound?.site.id).toBe(site.id);
  });

  it('locks missiles onto parts and destroys the compound', () => {
    const { combat, p } = setup(1600, 160);
    const c = () => combat.compounds.get(site.id);
    let destroyed = false;
    // Keep firing at whatever still stands until the compound falls.
    const events = run(combat, p, 60, (t) => {
      const tgt = c()?.parts.find((q) => !q.dead)?.def ?? site.parts[0];
      if (combat.missilesLeft === 0) combat.missilesLeft = 8;
      return { gun: false, missile: Math.floor(t * 60) % 45 === 0, flares: false, ray: rayTo(p, tgt.x, tgt.y + 1.5, tgt.z) };
    }, (e) => {
      if (e.some((x) => x.type === 'compoundDestroyed')) destroyed = true;
    });
    expect(events.some((e) => e.type === 'locked')).toBe(true);
    expect(events.some((e) => e.type === 'hitConfirm')).toBe(true);
    expect(destroyed).toBe(true);
    expect(c()!.destroyed).toBe(true);
    expect(compoundHealth(c()!)).toBe(0);
    expect(combat.destroyedCount).toBe(1);
  });

  it('a missile hit is decisive: two or three bring a compound down', () => {
    const { combat, p } = setup(1600, 160);
    run(combat, p, 0.1, () => ({ gun: false, missile: false, flares: false, ray: null }));
    const c = combat.compounds.get(site.id)!;
    const m = combat.loadout.missile!;
    let hits = 0;
    // Each missile strikes the biggest building still standing.
    while (!c.destroyed && hits < 10) {
      const q = c.parts.filter((x) => !x.dead).sort((a, b) => b.type.hp - a.type.hp)[0];
      combat.blast(q.cx, q.cy, q.cz, m.damage, m.radius, true);
      run(combat, p, 1.2, () => ({ gun: false, missile: false, flares: false, ray: null }));
      hits++;
    }
    expect(c.destroyed).toBe(true);
    expect(hits).toBeLessThanOrEqual(3);
    // One hit alone is not enough: the compound takes a second.
    expect(hits).toBeGreaterThan(1);
  });

  it('the gun wears a compound down', () => {
    const { combat, p } = setup(700, 80);
    const tgt = site.parts[0];
    run(combat, p, 4, () => ({ gun: true, missile: false, flares: false, ray: rayTo(p, tgt.x, tgt.y + 2, tgt.z) }));
    const c = combat.compounds.get(site.id)!;
    expect(c.hp).toBeLessThan(c.maxHp);
    expect(combat.gunAmmo).toBeLessThan(600);
  });

  it('defends itself: small arms within range, a missile when high enough', () => {
    const { combat, p, hits } = setup(800, 120);
    const events = run(combat, p, 25, () => ({ gun: false, missile: false, flares: false, ray: null }));
    expect(events.some((e) => e.type === 'enemyFire')).toBe(true);
    expect(events.some((e) => e.type === 'missileLaunch' && e.enemy)).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('holds fire beyond its reach', () => {
    const { combat, p, hits } = setup(ENEMY.sam.range + 900, 150);
    const events = run(combat, p, 8, () => ({ gun: false, missile: false, flares: false, ray: null }));
    expect(events.some((e) => e.type === 'enemyFire' || e.type === 'missileLaunch')).toBe(false);
    expect(hits.length).toBe(0);
  });

  it('flares pull missiles off the aircraft', () => {
    const { combat, p } = setup(2600, 200);
    let fired = false;
    let decoyed = 0;
    run(combat, p, 20, () => {
      const launch = !fired && combat.missiles.some((m) => m.enemy && m.age > 0.8);
      if (launch) fired = true;
      return { gun: false, missile: false, flares: launch, ray: null };
    }, () => {
      for (const m of combat.missiles) if (m.enemy && m.target.kind === 'flare') decoyed++;
    });
    expect(fired).toBe(true);
    expect(decoyed).toBeGreaterThan(0);
    expect(combat.flaresLeft).toBeLessThan(60);
  });

  it('a fallen compound is rebuilt once the aircraft is well away', () => {
    const { combat, p } = setup(1600, 160);
    const idle = () => ({ gun: false, missile: false, flares: false, ray: null });
    run(combat, p, 0.1, idle);
    const c = combat.compounds.get(site.id)!;
    combat.destroyCompound(c);
    combat.takeEvents();
    // Not before its time.
    run(combat, p, COMPOUNDS.respawnTime - 5, idle);
    expect(c.destroyed).toBe(true);
    // Time is up, but the aircraft is overhead: it waits.
    const over = player(200, 150);
    run(combat, over, 10, idle);
    expect(c.destroyed).toBe(true);
    // Fly off and the enemy moves back in, every part standing.
    const events = run(combat, player(COMPOUNDS.respawnClear + 400, 150), 2, idle);
    expect(events.some((e) => e.type === 'compoundRespawned')).toBe(true);
    expect(c.destroyed).toBe(false);
    expect(c.parts.every((q) => !q.dead && q.hp === q.type.hp)).toBe(true);
    expect(compoundHealth(c)).toBe(1);
    // And it can be taken again.
    combat.destroyCompound(c);
    expect(combat.destroyedCount).toBe(2);
  });

  it('the gunship ripples its 24 missiles while the trigger is held', () => {
    const { combat, p } = setup(2500, 200);
    combat.arm('gunship');
    const rack = LOADOUTS.gunship.missile!.rails.length;
    expect(rack).toBe(24);
    expect(combat.missilesLeft).toBe(rack);
    let empties = 0;
    run(combat, p, 8, (t) => ({ gun: false, missile: t < 1 / 60, missileHeld: true, flares: false, ray: null }), (e) => {
      empties += e.filter((x) => x.type === 'empty').length;
    });
    expect(combat.missilesLeft).toBe(0);
    // Holding on an empty rack does not keep sounding the empty tone.
    expect(empties).toBe(0);
  });
});

describe('wrecks from other pilots', () => {
  const idle = (): CombatInput => ({ gun: false, missile: false, flares: false, ray: null });

  it('a part wrecked before this aircraft arrives is already down, with no blast', () => {
    const { combat, p } = setup(900, 120);
    combat.applyRemotePart(site.id, 0);
    const events = run(combat, p, 0.1, idle);
    const c = combat.compounds.get(site.id)!;
    expect(c.parts[0].dead).toBe(true);
    expect(c.parts.slice(1).every((q) => !q.dead)).toBe(true);
    expect(events.some((e) => e.type === 'partDestroyed')).toBe(false);
  });

  it('a compound brought down elsewhere arrives as a ruin and is not credited here', () => {
    const { combat, p } = setup(900, 120);
    combat.applyRemoteCompound(site.id);
    const events = run(combat, p, 0.1, idle);
    expect(combat.compounds.get(site.id)!.destroyed).toBe(true);
    expect(combat.destroyedCount).toBe(0);
    expect(events.some((e) => e.type === 'compoundDestroyed')).toBe(false);
  });

  it('a part wrecked live blows up here, marked remote so it is not sent back', () => {
    const { combat, p } = setup(900, 120);
    run(combat, p, 0.1, idle);
    combat.applyRemotePart(site.id, 1);
    combat.applyRemotePart(site.id, 1);
    const events = combat.takeEvents().filter((e) => e.type === 'partDestroyed');
    expect(events.length).toBe(1);
    expect(events[0].type === 'partDestroyed' && events[0].remote).toBe(true);
    expect(combat.compounds.get(site.id)!.parts[1].dead).toBe(true);
  });

  it('ignores parts that do not exist', () => {
    const { combat, p } = setup(900, 120);
    run(combat, p, 0.1, idle);
    expect(() => combat.applyRemotePart(site.id, 250)).not.toThrow();
    expect(() => combat.applyRemotePart('nowhere', 3)).not.toThrow();
    expect(combat.compounds.get(site.id)!.parts.every((q) => !q.dead)).toBe(true);
  });
});

describe('wrecks from other pilots and rebuilding', () => {
  const idle = (): CombatInput => ({ gun: false, missile: false, flares: false, ray: null });

  it('a compound that fell elsewhere 100 s ago rebuilds about 20 s after this aircraft hears of it', () => {
    const { combat } = setup(900, 120);
    const far = player(5000, 300);
    run(combat, far, 0.1, idle);
    combat.applyRemoteCompound(site.id, 100);
    run(combat, far, 1.2, idle);
    const c = combat.compounds.get(site.id)!;
    expect(c.destroyed).toBe(true);
    expect(c.respawnAt - combat.time).toBeGreaterThan(17);
    expect(c.respawnAt - combat.time).toBeLessThan(21);
  });

  it('the relay forgets wrecks on the same clock the game rebuilds them', async () => {
    const { WRECK_MEMORY } = await import('../../src/net/protocol');
    const { COMPOUNDS } = await import('../../src/data/weapons');
    expect(WRECK_MEMORY).toBe(COMPOUNDS.respawnTime);
  });
});
