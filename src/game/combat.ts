import { COMPOUNDS, ENEMY, LOADOUTS, type EnemyGun, type Loadout } from '../data/weapons';
import { compoundsNear, PART_TYPES, type CompoundPart, type CompoundSite, type PartType } from '../world/compounds';
import { newSample } from '../world/terrain';
import type { World } from '../world/world';

/**
 * The shooting war: the player's guns, missiles and flares, the compounds'
 * machine guns, flak and surface-to-air missiles, and everything in flight
 * between them. Pure logic with no rendering: the renderer, HUD and audio read
 * its state and drain its event queue each frame.
 */

const G = 9.81;

/** The aircraft as combat sees it, at this frame's render pose. */
export interface PlayerState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Body → world rotation. */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  /** Radius of the sphere enemy fire must hit. */
  radius: number;
  /** Height above the ground. */
  agl: number;
  alive: boolean;
  /** The aircraft's damage multiplier. */
  fragility: number;
}

export interface CombatInput {
  /** Gun trigger held. */
  gun: boolean;
  /** Missile and flare buttons pressed this frame. */
  missile: boolean;
  flares: boolean;
  /** Missile button held down: ripple fire as fast as the rails reload. */
  missileHeld?: boolean;
  /** The sight line: from the camera through the reticle (unit direction). */
  ray: { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number } | null;
}

export interface CombatHost {
  /** Apply damage to the aircraft (already scaled for its fragility). `crit` is the chance of a tail-rotor hit. */
  hit(amount: number, reason: string, crit: number): void;
}

export interface PartState {
  def: CompoundPart;
  type: PartType;
  index: number;
  hp: number;
  dead: boolean;
  /** Hit-box centre. */
  cx: number;
  cy: number;
  cz: number;
  /** Gun or launcher position. */
  mx: number;
  my: number;
  mz: number;
  /** Where the mount points (world yaw, pitch), for the renderer. */
  aimYaw: number;
  aimPitch: number;
  cool: number;
  burst: number;
  shot: number;
  biasX: number;
  biasY: number;
  biasZ: number;
  /** SAM: seconds of lock built up, and time until the next launch. */
  lock: number;
  reload: number;
  /** Seconds since this mount last fired, for muzzle flashes. */
  flash: number;
}

export interface CompoundState {
  site: CompoundSite;
  parts: PartState[];
  hp: number;
  maxHp: number;
  destroyed: boolean;
  /** The compound can see the aircraft. */
  sees: boolean;
  seeTimer: number;
  /** Distance to the aircraft. */
  dist: number;
  /** Some weapon here is in range and shooting. */
  engaged: boolean;
  /**
   * Blast damage beyond what the parts it hit could absorb: it shakes the
   * whole compound, so a heavy warhead is not wasted on a light target.
   */
  structural: number;
  /** Combat clock time at which a fallen compound is rebuilt. */
  respawnAt: number;
}

export const enum Owner {
  Player = 0,
  Mg = 1,
  Aaa = 2,
}

export interface Bullet {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  owner: Owner;
  damage: number;
  splash: number;
  tracer: boolean;
  nearMissed: boolean;
}

export type MissileTarget =
  | { kind: 'player' }
  | { kind: 'flare'; flare: Flare }
  | { kind: 'point'; x: number; y: number; z: number; part: PartState | null }
  | { kind: 'none' };

export interface Missile {
  enemy: boolean;
  x: number;
  y: number;
  z: number;
  /** Heading (unit) and speed once the motor runs; free-fall velocity before. */
  dx: number;
  dy: number;
  dz: number;
  speed: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  /** Seconds of drop before the motor lights (player missiles fall clear of the rails). */
  delay: number;
  target: MissileTarget;
  minDist: number;
  alive: boolean;
  /** Launcher, so a SAM site waits for its last shot. */
  source: PartState | null;
}

export interface Flare {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
}

export type CombatEvent =
  | { type: 'gunFire'; x: number; y: number; z: number }
  | { type: 'enemyFire'; x: number; y: number; z: number; kind: Owner; dist: number }
  | { type: 'impact'; x: number; y: number; z: number; water: boolean; hit: boolean; player: boolean }
  | { type: 'flak'; x: number; y: number; z: number }
  | { type: 'explosion'; x: number; y: number; z: number; size: number }
  | { type: 'partDestroyed'; x: number; y: number; z: number; size: number; part: PartState; compound: CompoundState }
  | { type: 'compoundDestroyed'; compound: CompoundState }
  | { type: 'compoundRespawned'; compound: CompoundState }
  | { type: 'missileLaunch'; enemy: boolean; x: number; y: number; z: number }
  | { type: 'flare'; x: number; y: number; z: number }
  | { type: 'playerHit'; amount: number; fromX: number; fromZ: number; missile: boolean }
  | { type: 'nearMiss' }
  | { type: 'hitConfirm'; kill: boolean }
  | { type: 'locked' }
  | { type: 'empty'; weapon: 'gun' | 'missile' | 'flares' };

interface PendingBlast {
  t: number;
  x: number;
  y: number;
  z: number;
  damage: number;
  radius: number;
  size: number;
}

/** Where the sight line meets the world, and what is under the reticle. */
export interface AimState {
  x: number;
  y: number;
  z: number;
  dist: number;
  part: PartState | null;
  compound: CompoundState | null;
}

export interface LockState {
  part: PartState | null;
  compound: CompoundState | null;
  progress: number;
  locked: boolean;
}

/** Remaining strength shown on the HUD: 1 intact, 0 the moment it falls. */
export function compoundHealth(c: CompoundState): number {
  if (c.destroyed) return 0;
  const f = c.hp / c.maxHp;
  return Math.max(0, Math.min(1, (f - COMPOUNDS.breakAt) / (1 - COMPOUNDS.breakAt)));
}

export class Combat {
  /** Every compound the aircraft has come near this session, live or wrecked. */
  readonly compounds = new Map<string, CompoundState>();
  /** Compounds near enough to matter this frame. */
  active: CompoundState[] = [];
  readonly bullets: Bullet[] = [];
  readonly missiles: Missile[] = [];
  readonly flares: Flare[] = [];
  events: CombatEvent[] = [];
  readonly aim: AimState = { x: 0, y: 0, z: 0, dist: 0, part: null, compound: null };
  readonly lock: LockState = { part: null, compound: null, progress: 0, locked: false };

  loadout: Loadout = LOADOUTS.medium;
  gunAmmo = 0;
  missilesLeft = 0;
  flaresLeft = 0;
  destroyedCount = 0;
  /** Seconds of combat so far: the clock compound rebuilds run on. */
  time = 0;
  /** Threat picture for the warning system. */
  samLocking = false;
  incoming = 0;
  /** World bearings (atan2 of x, z offsets) of compounds shooting at the aircraft. */
  threats: number[] = [];
  /** Start position: no compounds near it. */
  home = { x: 0, z: 0 };

  private sites = new Map<string, CompoundSite | null>();
  private refreshTimer = 0;
  private gunTimer = 0;
  private muzzle = 0;
  private missileTimer = 0;
  private flareQueue = 0;
  private flareTimer = 0;
  private flareCool = 0;
  private dispenser = 0;
  private lockCheck = 0;
  private lockVisible = false;
  private aimTimer = 0;
  private pending: PendingBlast[] = [];
  private gunAcc = 0;
  private flareAcc = 0;
  private missileAcc = 0;
  private sample = newSample();
  private readonly rand: () => number;
  private v = [0, 0, 0];
  private u = [0, 0, 0];

  constructor(private world: World, private host: CombatHost, rand: () => number = Math.random) {
    this.rand = rand;
  }

  /** Load the weapons for an aircraft and clear everything in the air (a fresh spawn). */
  arm(aircraftId: string): void {
    this.loadout = LOADOUTS[aircraftId] ?? { flares: 30, salvo: 4, dispensers: [[-1, -0.5, 1.5], [1, -0.5, 1.5]] };
    this.gunAmmo = this.loadout.gun?.ammo ?? 0;
    this.missilesLeft = this.loadout.missile?.rails.length ?? 0;
    this.flaresLeft = this.loadout.flares;
    this.bullets.length = 0;
    this.missiles.length = 0;
    this.flares.length = 0;
    this.pending.length = 0;
    this.events.length = 0;
    this.flareQueue = 0;
    this.gunTimer = this.missileTimer = this.flareCool = 0;
    this.lock.part = null;
    this.lock.compound = null;
    this.lock.progress = 0;
    this.lock.locked = false;
    this.samLocking = false;
    this.incoming = 0;
    this.threats.length = 0;
    this.refreshTimer = 0;
    for (const c of this.compounds.values()) {
      for (const p of c.parts) {
        p.lock = 0;
        p.reload = 2;
        p.cool = 1 + this.rand() * 2;
        p.burst = 0;
      }
    }
  }

  /** True when every gun, rail and flare bucket is full. */
  get fullyArmed(): boolean {
    const L = this.loadout;
    return this.gunAmmo >= (L.gun?.ammo ?? 0) && this.missilesLeft >= (L.missile?.rails.length ?? 0) && this.flaresLeft >= L.flares;
  }

  /**
   * Reload from a supply point over `dt` seconds: the gun and flares fill at a
   * steady rate, missiles go back on their rails one at a time.
   */
  rearm(dt: number, gunTime: number, flareTime: number, missileEvery: number): void {
    const L = this.loadout;
    if (L.gun && this.gunAmmo < L.gun.ammo) {
      this.gunAcc += (L.gun.ammo / gunTime) * dt;
      const n = Math.floor(this.gunAcc);
      this.gunAcc -= n;
      this.gunAmmo = Math.min(L.gun.ammo, this.gunAmmo + n);
    }
    if (this.flaresLeft < L.flares) {
      this.flareAcc += (L.flares / flareTime) * dt;
      const n = Math.floor(this.flareAcc);
      this.flareAcc -= n;
      this.flaresLeft = Math.min(L.flares, this.flaresLeft + n);
    }
    const rails = L.missile?.rails.length ?? 0;
    if (this.missilesLeft < rails) {
      this.missileAcc += dt;
      if (this.missileAcc >= missileEvery) {
        this.missileAcc = 0;
        this.missilesLeft++;
      }
    } else this.missileAcc = 0;
  }

  takeEvents(): CombatEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Ground or sea surface under a point. */
  surface(x: number, z: number, detail = 12): number {
    return Math.max(0, this.world.sample(x, z, detail, this.sample));
  }

  /** True when nothing but air lies between two points. */
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const d = Math.hypot(bx - ax, bz - az);
    const n = Math.max(6, Math.min(36, Math.ceil(d / 70)));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
      if (y < this.surface(x, z, 40) + 1.5) return false;
    }
    return true;
  }

  update(dt: number, p: PlayerState, input: CombatInput, live: boolean): void {
    if (dt <= 0) return;
    this.time += dt;
    this.refreshTimer -= dt;
    if (this.refreshTimer <= 0) {
      this.refreshTimer = 1;
      this.respawnDue(p);
      this.refresh(p);
    }
    for (const c of this.active) c.dist = Math.hypot(c.site.x - p.x, c.site.z - p.z);
    this.updateAim(dt, input);
    if (live) {
      this.updatePlayerWeapons(dt, p, input);
      this.updateEnemies(dt, p);
    }
    this.updateFlares(dt);
    this.updateBullets(dt, p);
    this.updateMissiles(dt, p);
    this.updatePending(dt);
    this.incoming = 0;
    for (const m of this.missiles) if (m.enemy && m.target.kind === 'player') this.incoming++;
  }

  // ---- Compounds ------------------------------------------------------------------

  private refresh(p: PlayerState): void {
    const sites = compoundsNear(this.world, p.x, p.z, COMPOUNDS.activeRange, this.sites, { x: this.home.x, z: this.home.z, r: COMPOUNDS.homeClear });
    this.active = sites.map((s) => this.compounds.get(s.id) ?? this.makeCompound(s));
    // Forget generated cells once the cache grows; they are cheap to make again.
    if (this.sites.size > 600) this.sites.clear();
  }

  private makeCompound(site: CompoundSite): CompoundState {
    const parts = site.parts.map((def, index): PartState => {
      const type = PART_TYPES[def.kind];
      return {
        def, type, index, hp: type.hp, dead: false,
        cx: def.x, cy: def.y + type.hy - 0.25, cz: def.z,
        mx: def.x, my: def.y + (type.mount ?? type.hy * 2), mz: def.z,
        aimYaw: def.yaw, aimPitch: 0.25,
        cool: 1 + this.rand() * 2, burst: 0, shot: 0, biasX: 0, biasY: 0, biasZ: 0,
        lock: 0, reload: 2, flash: 9,
      };
    });
    const maxHp = parts.reduce((s, q) => s + q.hp, 0);
    const c: CompoundState = { site, parts, hp: maxHp, maxHp, structural: 0, destroyed: false, sees: false, seeTimer: this.rand() * 0.4, dist: Infinity, engaged: false, respawnAt: Infinity };
    this.compounds.set(site.id, c);
    return c;
  }

  /** Damage one part; it may go up, and take the compound with it. Returns the damage the part could not absorb. */
  damagePart(c: CompoundState, part: PartState, amount: number, byPlayer: boolean): number {
    if (part.dead || c.destroyed || amount <= 0) return 0;
    const excess = Math.max(0, amount - part.hp);
    part.hp -= amount;
    const kill = part.hp <= 0;
    if (byPlayer) this.events.push({ type: 'hitConfirm', kill });
    if (kill) {
      part.hp = 0;
      part.dead = true;
      const t = part.type;
      const size = Math.min(2.2, 0.5 + Math.max(t.hx, t.hz, t.hy) / 5);
      this.events.push({ type: 'partDestroyed', x: part.cx, y: part.cy, z: part.cz, size, part, compound: c });
      if (t.secondary) {
        this.pending.push({ t: 0.15 + this.rand() * 0.45, x: part.cx, y: part.cy + 1, z: part.cz, damage: t.secondary[0], radius: t.secondary[1], size: 0.7 + t.secondary[1] / 25 });
      }
    }
    this.recount(c);
    return excess;
  }

  private recount(c: CompoundState): void {
    if (c.destroyed) return;
    c.hp = Math.max(0, c.parts.reduce((s, q) => s + Math.max(0, q.hp), 0) - c.structural);
    if (c.hp <= COMPOUNDS.breakAt * c.maxHp) this.destroyCompound(c);
  }

  destroyCompound(c: CompoundState): void {
    if (c.destroyed) return;
    c.destroyed = true;
    c.engaged = false;
    for (const q of c.parts) {
      q.dead = true;
      q.hp = 0;
    }
    c.hp = 0;
    c.respawnAt = this.time + COMPOUNDS.respawnTime;
    this.destroyedCount++;
    this.events.push({ type: 'compoundDestroyed', compound: c });
    for (const m of this.missiles) if (m.source && c.parts.includes(m.source)) m.source = null;
  }

  /** Fallen compounds whose time is up are rebuilt, once the aircraft is well clear of them. */
  private respawnDue(p: PlayerState): void {
    for (const c of this.compounds.values()) {
      if (!c.destroyed || this.time < c.respawnAt) continue;
      if (Math.hypot(c.site.x - p.x, c.site.z - p.z) < COMPOUNDS.respawnClear) continue;
      this.respawnCompound(c);
    }
  }

  /** The enemy moves back in: every part stands again at full strength, guns cold. */
  respawnCompound(c: CompoundState): void {
    if (!c.destroyed) return;
    for (const q of c.parts) {
      q.hp = q.type.hp;
      q.dead = false;
      q.aimYaw = q.def.yaw;
      q.aimPitch = 0.25;
      q.cool = 1 + this.rand() * 2;
      q.burst = 0;
      q.lock = 0;
      q.reload = 3;
      q.flash = 9;
    }
    c.structural = 0;
    c.hp = c.maxHp;
    c.destroyed = false;
    c.sees = false;
    c.engaged = false;
    c.respawnAt = Infinity;
    this.events.push({ type: 'compoundRespawned', compound: c });
  }

  /** Blast damage to every part within `radius` of a point. */
  blast(x: number, y: number, z: number, damage: number, radius: number, byPlayer: boolean): void {
    for (const c of this.active) {
      if (c.destroyed || Math.hypot(c.site.x - x, c.site.z - z) > c.site.half * 1.6 + radius) continue;
      let excess = 0;
      for (const q of c.parts) {
        if (q.dead) continue;
        const d = this.boxDistance(q, x, y, z);
        if (d < radius) excess += this.damagePart(c, q, damage * Math.pow(1 - d / radius, 0.8), byPlayer);
      }
      if (excess > 0 && !c.destroyed) {
        c.structural += excess * COMPOUNDS.structuralShare;
        this.recount(c);
      }
    }
  }

  private boxDistance(q: PartState, x: number, y: number, z: number): number {
    const t = q.type, yaw = q.def.yaw;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const dx = x - q.cx, dz = z - q.cz;
    const lx = dx * c - dz * s, lz = dx * s + dz * c, ly = y - q.cy;
    const ox = Math.max(0, Math.abs(lx) - t.hx), oy = Math.max(0, Math.abs(ly) - t.hy - 0.25), oz = Math.max(0, Math.abs(lz) - t.hz);
    return Math.hypot(ox, oy, oz);
  }

  /** First live part a segment passes through, with the fraction along it. */
  private segmentPart(ax: number, ay: number, az: number, bx: number, by: number, bz: number): { t: number; c: CompoundState; q: PartState } | null {
    let best: { t: number; c: CompoundState; q: PartState } | null = null;
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    for (const c of this.active) {
      if (c.destroyed) continue;
      // Quick reject: the compound is nowhere near the segment.
      if (Math.hypot(c.site.x - mx, c.site.z - mz) > c.site.half * 1.6 + len / 2) continue;
      for (const q of c.parts) {
        if (q.dead) continue;
        const t = this.segmentBox(q, ax, ay, az, bx, by, bz);
        if (t < (best?.t ?? Infinity)) best = { t, c, q };
      }
    }
    return best;
  }

  private segmentBox(q: PartState, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    const T = q.type, yaw = q.def.yaw;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const adx = ax - q.cx, adz = az - q.cz, bdx = bx - q.cx, bdz = bz - q.cz;
    const lax = adx * c - adz * s, laz = adx * s + adz * c;
    const lbx = bdx * c - bdz * s, lbz = bdx * s + bdz * c;
    const a = [lax, ay - q.cy, laz], d = [lbx - lax, by - ay, lbz - laz], h = [T.hx, T.hy + 0.25, T.hz];
    let t0 = 0, t1 = 1;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-9) {
        if (Math.abs(a[k]) > h[k]) return Infinity;
        continue;
      }
      let u = (-h[k] - a[k]) / d[k], v = (h[k] - a[k]) / d[k];
      if (u > v) [u, v] = [v, u];
      t0 = Math.max(t0, u);
      t1 = Math.min(t1, v);
      if (t0 > t1) return Infinity;
    }
    return t0;
  }

  // ---- Aim and lock ---------------------------------------------------------------

  private updateAim(dt: number, input: CombatInput): void {
    const r = input.ray;
    if (!r) return;
    this.aimTimer -= dt;
    if (this.aimTimer > 0) return;
    this.aimTimer = 1 / 30;
    const far = 4500;
    // Terrain: march out with a growing step, then refine the crossing.
    let hitT = far;
    let prevT = 0;
    for (let t = 4; t < far; t += 6 + t * 0.045) {
      const y = r.oy + r.dy * t;
      if (y < this.surface(r.ox + r.dx * t, r.oz + r.dz * t, 24)) {
        let lo = prevT, hi = t;
        for (let k = 0; k < 7; k++) {
          const m = (lo + hi) / 2;
          if (r.oy + r.dy * m < this.surface(r.ox + r.dx * m, r.oz + r.dz * m, 12)) hi = m;
          else lo = m;
        }
        hitT = hi;
        break;
      }
      prevT = t;
    }
    const hit = this.segmentPart(r.ox, r.oy, r.oz, r.ox + r.dx * hitT, r.oy + r.dy * hitT, r.oz + r.dz * hitT);
    const t = hit ? hit.t * hitT : hitT;
    const a = this.aim;
    a.x = r.ox + r.dx * t;
    a.y = r.oy + r.dy * t;
    a.z = r.oz + r.dz * t;
    a.dist = t;
    a.part = hit?.q ?? null;
    a.compound = hit?.c ?? null;
    // A compound counts as under the reticle even between its buildings.
    if (!a.compound && t < far) {
      for (const c of this.active) {
        if (!c.destroyed && Math.hypot(c.site.x - a.x, c.site.z - a.z) < c.site.half * 1.15) a.compound = c;
      }
    }
  }

  private updateLock(dt: number, p: PlayerState, input: CombatInput): void {
    const m = this.loadout.missile, L = this.lock;
    if (!m || !input.ray || this.missilesLeft <= 0 || !p.alive) {
      L.part = null;
      L.compound = null;
      L.progress = 0;
      L.locked = false;
      return;
    }
    const r = input.ray;
    const cone = Math.cos((m.lockCone * Math.PI) / 180);
    let best: PartState | null = this.aim.part, bestC: CompoundState | null = this.aim.compound;
    if (best && Math.hypot(best.cx - p.x, best.cy - p.y, best.cz - p.z) > m.lockRange) best = null;
    if (!best) {
      let bestScore = cone;
      bestC = null;
      // Hold on to the part already being tracked unless another sits clearly nearer the sight line.
      const cur = L.part;
      if (cur && !cur.dead && L.compound && !L.compound.destroyed) {
        const dx = cur.cx - r.ox, dy = cur.cy - r.oy, dz = cur.cz - r.oz;
        const dot = (dx * r.dx + dy * r.dy + dz * r.dz) / Math.hypot(dx, dy, dz);
        if (dot > cone && Math.hypot(cur.cx - p.x, cur.cz - p.z) < m.lockRange) {
          best = cur;
          bestC = L.compound;
          bestScore = dot + 0.004;
        }
      }
      for (const c of this.active) {
        if (c.destroyed || c.dist > m.lockRange + 200) continue;
        for (const q of c.parts) {
          if (q.dead) continue;
          const dx = q.cx - r.ox, dy = q.cy - r.oy, dz = q.cz - r.oz;
          const dot = (dx * r.dx + dy * r.dy + dz * r.dz) / Math.hypot(dx, dy, dz);
          // Whatever sits closest to the sight line, with a nudge toward the defences.
          const score = dot + (q.type.weapon ? 0.002 : 0);
          if (score > bestScore && Math.hypot(q.cx - p.x, q.cz - p.z) < m.lockRange) {
            bestScore = score;
            best = q;
            bestC = c;
          }
        }
      }
    }
    if (best !== L.part) {
      L.part = best;
      L.compound = bestC;
      L.progress = 0;
      L.locked = false;
      this.lockCheck = 0;
    }
    if (!best) return;
    this.lockCheck -= dt;
    if (this.lockCheck <= 0) {
      this.lockCheck = 0.25;
      this.lockVisible = this.lineOfSight(p.x, p.y - 1, p.z, best.cx, best.cy + best.type.hy * 0.5, best.cz);
    }
    if (!this.lockVisible) {
      L.progress = Math.max(0, L.progress - dt * 2);
      L.locked = false;
      return;
    }
    L.progress = Math.min(1, L.progress + dt / m.lockTime);
    if (L.progress >= 1 && !L.locked) {
      L.locked = true;
      this.events.push({ type: 'locked' });
    }
  }

  // ---- Player weapons ------------------------------------------------------------

  /** Rotate a body-axis vector to world axes at the player's pose (`inv` for world → body). */
  private rotate(p: PlayerState, bx: number, by: number, bz: number, out: number[], inv = false): number[] {
    const x = inv ? -p.qx : p.qx, y = inv ? -p.qy : p.qy, z = inv ? -p.qz : p.qz, w = p.qw;
    const tx = 2 * (y * bz - z * by), ty = 2 * (z * bx - x * bz), tz = 2 * (x * by - y * bx);
    out[0] = bx + w * tx + (y * tz - z * ty);
    out[1] = by + w * ty + (z * tx - x * tz);
    out[2] = bz + w * tz + (x * ty - y * tx);
    return out;
  }

  private updatePlayerWeapons(dt: number, p: PlayerState, input: CombatInput): void {
    this.updateLock(dt, p, input);
    const L = this.loadout;
    // Gun: the first round leaves the moment the trigger is pressed.
    const gun = L.gun;
    if (gun && input.gun && p.alive) {
      if (this.gunAmmo <= 0) {
        if (this.gunTimer <= 0) this.events.push({ type: 'empty', weapon: 'gun' });
        this.gunTimer = 0.6;
      }
      this.gunTimer -= dt;
      while (this.gunTimer <= 0 && this.gunAmmo > 0) {
        this.fireGun(p);
        this.gunTimer += 1 / gun.rate;
      }
    } else {
      this.gunTimer = Math.max(0, this.gunTimer - dt);
    }

    this.missileTimer -= dt;
    if ((input.missile || input.missileHeld) && p.alive) {
      // Only a fresh press reports an empty rack, so holding the button does not drone.
      if (!L.missile || this.missilesLeft <= 0) {
        if (input.missile) this.events.push({ type: 'empty', weapon: 'missile' });
      } else if (this.missileTimer <= 0) this.fireMissile(p);
    }

    this.flareCool -= dt;
    if (input.flares && p.alive) {
      if (this.flaresLeft <= 0) this.events.push({ type: 'empty', weapon: 'flares' });
      else if (this.flareCool <= 0) {
        const n = Math.min(L.salvo, this.flaresLeft);
        this.flaresLeft -= n;
        this.flareQueue += n;
        this.flareCool = 0.8;
        // The first pair goes now, and every missile chasing the aircraft weighs it up.
        this.releaseFlares(p);
        const decoy = this.flares[this.flares.length - 1];
        for (const m of this.missiles) {
          if (m.enemy && m.target.kind === 'player' && decoy && this.rand() < ENEMY.sam.decoy) m.target = { kind: 'flare', flare: decoy };
        }
      }
    }
    if (this.flareQueue > 0) {
      this.flareTimer -= dt;
      if (this.flareTimer <= 0) this.releaseFlares(p);
    }
  }

  private fireGun(p: PlayerState): void {
    const gun = this.loadout.gun!;
    const mz = gun.muzzles[this.muzzle++ % gun.muzzles.length];
    const o = this.rotate(p, mz[0], mz[1], mz[2], this.v);
    const ox = p.x + o[0], oy = p.y + o[1], oz = p.z + o[2];
    // Toward the aim point, raised for the drop over the distance.
    const a = this.aim;
    let dy = a.y - oy;
    const dx = a.x - ox, dz = a.z - oz;
    const tof = Math.hypot(dx, dy, dz) / gun.speed;
    dy += 0.5 * G * tof * tof;
    // Inside the turret's travel.
    const b = this.rotate(p, dx, dy, dz, this.u, true);
    const l = Math.hypot(b[0], b[1], b[2]) || 1;
    const R = Math.PI / 180;
    const yaw = Math.max(-gun.yawLimit * R, Math.min(gun.yawLimit * R, Math.atan2(b[0] / l, -b[2] / l)));
    const pitch = Math.max(gun.pitchMin * R, Math.min(gun.pitchMax * R, Math.asin(Math.max(-1, Math.min(1, b[1] / l)))));
    const w = this.rotate(p, Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch), this.u);
    const s = gun.spread;
    const gx = w[0] + this.gauss() * s, gy = w[1] + this.gauss() * s, gz = w[2] + this.gauss() * s;
    const gl = Math.hypot(gx, gy, gz);
    this.gunAmmo--;
    this.bullets.push({
      x: ox, y: oy, z: oz,
      vx: (gx / gl) * gun.speed + p.vx, vy: (gy / gl) * gun.speed + p.vy, vz: (gz / gl) * gun.speed + p.vz,
      life: 4, owner: Owner.Player, damage: gun.damage, splash: gun.splash,
      tracer: this.gunAmmo % gun.tracerEvery === 0, nearMissed: true,
    });
    this.events.push({ type: 'gunFire', x: ox, y: oy, z: oz });
  }

  private fireMissile(p: PlayerState): void {
    const spec = this.loadout.missile!;
    const rail = spec.rails[spec.rails.length - this.missilesLeft];
    this.missilesLeft--;
    this.missileTimer = spec.reload;
    const o = this.rotate(p, rail[0], rail[1], rail[2], this.v);
    const f = this.rotate(p, 0, 0, -1, this.u);
    const L = this.lock;
    const target: MissileTarget = L.locked && L.part
      ? { kind: 'point', x: L.part.cx, y: L.part.cy, z: L.part.cz, part: L.part }
      : { kind: 'point', x: this.aim.x, y: this.aim.y, z: this.aim.z, part: null };
    const fl = Math.hypot(f[0], f[1], f[2]);
    const x = p.x + o[0], y = p.y + o[1], z = p.z + o[2];
    this.missiles.push({
      enemy: false, x, y, z,
      dx: f[0] / fl, dy: f[1] / fl, dz: f[2] / fl, speed: 0,
      vx: p.vx, vy: p.vy - 2.5, vz: p.vz,
      age: 0, delay: 0.2, target, minDist: Infinity, alive: true, source: null,
    });
    this.events.push({ type: 'missileLaunch', enemy: false, x, y, z });
    // The next missile has to settle its lock again.
    if (L.locked) {
      L.progress = 0.35;
      L.locked = false;
    }
  }

  private releaseFlares(p: PlayerState): void {
    const L = this.loadout;
    for (let k = 0; k < 2 && this.flareQueue > 0; k++) {
      const d = L.dispensers[this.dispenser++ % L.dispensers.length];
      const side = Math.sign(d[0]) || 1;
      const o = this.rotate(p, d[0], d[1], d[2], this.v);
      const v = this.rotate(p, side * (12 + this.rand() * 8), -5 - this.rand() * 6, 5 + this.rand() * 6, this.u);
      const x = p.x + o[0], y = p.y + o[1], z = p.z + o[2];
      this.flares.push({ x, y, z, vx: p.vx + v[0], vy: p.vy + v[1], vz: p.vz + v[2], age: 0, life: 3.6 + this.rand() * 1.2 });
      this.flareQueue--;
      this.events.push({ type: 'flare', x, y, z });
    }
    this.flareTimer = 0.14;
  }

  private updateFlares(dt: number): void {
    const f = this.flares;
    let n = 0;
    const k = Math.exp(-1.1 * dt);
    for (let i = 0; i < f.length; i++) {
      const q = f[i];
      q.age += dt;
      if (q.age >= q.life) continue;
      q.vx *= k;
      q.vz *= k;
      q.vy = q.vy * k - G * 0.5 * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.z += q.vz * dt;
      f[n++] = q;
    }
    f.length = n;
  }

  // ---- Enemy fire ----------------------------------------------------------------

  private updateEnemies(dt: number, p: PlayerState): void {
    this.samLocking = false;
    this.threats.length = 0;
    const speed = Math.hypot(p.vx, p.vy, p.vz);
    for (const c of this.active) {
      c.engaged = false;
      if (c.destroyed || c.dist > ENEMY.sam.range + 300) {
        c.sees = false;
        continue;
      }
      c.seeTimer -= dt;
      if (c.seeTimer <= 0) {
        c.seeTimer = 0.35 + this.rand() * 0.15;
        c.sees = p.alive && this.lineOfSight(c.site.x, c.site.y + 9, c.site.z, p.x, p.y, p.z);
      }
      for (const q of c.parts) {
        const w = q.type.weapon;
        if (!w || q.dead) continue;
        q.flash += dt;
        q.reload -= dt;
        const dx = p.x - q.mx, dy = p.y - q.my, dz = p.z - q.mz;
        const d = Math.hypot(dx, dy, dz);
        const range = w === 'sam' ? ENEMY.sam.range : ENEMY[w].range;
        if (!c.sees || !p.alive || d > range) {
          q.lock = Math.max(0, q.lock - dt);
          q.burst = 0;
          continue;
        }
        // Swing the mount round toward the aircraft.
        const slew = w === 'sam' ? 0.8 : ENEMY[w].slew;
        let dYaw = Math.atan2(dx, dz) - q.aimYaw;
        dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
        q.aimYaw += Math.max(-slew * dt, Math.min(slew * dt, dYaw));
        q.aimPitch += Math.max(-slew * dt, Math.min(slew * dt, Math.atan2(dy, Math.hypot(dx, dz)) - q.aimPitch));
        const onTarget = Math.abs(dYaw) < 0.25;
        if (w === 'sam') {
          const S = ENEMY.sam;
          if (p.agl < S.minAgl || d < S.minRange) {
            q.lock = Math.max(0, q.lock - dt);
            continue;
          }
          q.lock += dt;
          this.samLocking = true;
          c.engaged = true;
          const busy = this.missiles.some((m) => m.source === q);
          if (q.lock >= S.lockTime && q.reload <= 0 && !busy && onTarget) this.launchSam(q, p);
          continue;
        }
        const g: EnemyGun = ENEMY[w];
        c.engaged = true;
        q.cool -= dt;
        if (q.burst <= 0) {
          if (q.cool <= 0 && onTarget) {
            q.burst = g.burstMin + Math.floor(this.rand() * (g.burstMax - g.burstMin + 1));
            q.shot = 0;
            // Each burst is off by a little, more against a fast target.
            const b = g.bias + g.biasPerSpeed * speed;
            q.biasX = this.gauss() * b;
            q.biasY = this.gauss() * b;
            q.biasZ = this.gauss() * b;
          }
          continue;
        }
        q.shot -= dt;
        while (q.shot <= 0 && q.burst > 0) {
          this.fireEnemyGun(q, g, w === 'aaa' ? Owner.Aaa : Owner.Mg, p, d);
          q.burst--;
          q.shot += 1 / g.rate;
        }
        if (q.burst <= 0) q.cool = g.pauseMin + this.rand() * (g.pauseMax - g.pauseMin);
      }
      if (c.engaged) this.threats.push(Math.atan2(c.site.x - p.x, c.site.z - p.z));
    }
  }

  private fireEnemyGun(q: PartState, g: EnemyGun, owner: Owner, p: PlayerState, d: number): void {
    // Lead the target by the time of flight, and hold off for the drop.
    const tof = d / g.speed;
    const tx = p.x + p.vx * tof, ty = p.y + p.vy * tof + 0.5 * G * tof * tof, tz = p.z + p.vz * tof;
    let dx = tx - q.mx, dy = ty - q.my, dz = tz - q.mz;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx = dx / l + q.biasX + this.gauss() * g.spread;
    dy = dy / l + q.biasY + this.gauss() * g.spread;
    dz = dz / l + q.biasZ + this.gauss() * g.spread;
    const n = Math.hypot(dx, dy, dz);
    this.bullets.push({
      x: q.mx, y: q.my, z: q.mz,
      vx: (dx / n) * g.speed, vy: (dy / n) * g.speed, vz: (dz / n) * g.speed,
      life: Math.min(4, (g.range * 1.25) / g.speed), owner, damage: g.damage, splash: g.proximity, tracer: true, nearMissed: false,
    });
    q.flash = 0;
    this.events.push({ type: 'enemyFire', x: q.mx, y: q.my, z: q.mz, kind: owner, dist: d });
  }

  private launchSam(q: PartState, p: PlayerState): void {
    const S = ENEMY.sam;
    q.reload = S.reload;
    q.lock = S.lockTime * 0.5;
    q.flash = 0;
    // Off the rail steeply, then the seeker takes over.
    const h = Math.hypot(p.x - q.mx, p.z - q.mz) || 1;
    const el = 0.9;
    const m: Missile = {
      enemy: true, x: q.mx, y: q.my + 0.5, z: q.mz,
      dx: ((p.x - q.mx) / h) * Math.cos(el), dy: Math.sin(el), dz: ((p.z - q.mz) / h) * Math.cos(el), speed: 35,
      vx: 0, vy: 0, vz: 0, age: 0, delay: 0, target: { kind: 'player' }, minDist: Infinity, alive: true, source: q,
    };
    // Flares already burning may take it straight away.
    const fresh = this.flares.filter((f) => f.age < 1.6);
    if (fresh.length && this.rand() < 0.5) m.target = { kind: 'flare', flare: fresh[fresh.length - 1] };
    this.missiles.push(m);
    this.events.push({ type: 'missileLaunch', enemy: true, x: q.mx, y: q.my, z: q.mz });
  }

  // ---- Things in flight ---------------------------------------------------------------

  private updateBullets(dt: number, p: PlayerState): void {
    const list = this.bullets;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const ax = b.x, ay = b.y, az = b.z;
      b.vy -= G * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      b.life -= dt;
      let gone = false;
      if (b.owner === Owner.Player) {
        const hit = this.segmentPart(ax, ay, az, b.x, b.y, b.z);
        if (hit) {
          const t = hit.t;
          const hx = ax + (b.x - ax) * t, hy = ay + (b.y - ay) * t, hz = az + (b.z - az) * t;
          this.damagePart(hit.c, hit.q, b.damage, true);
          if (b.splash > 0) this.blast(hx, hy, hz, b.damage * 0.35, b.splash, true);
          this.events.push({ type: 'impact', x: hx, y: hy, z: hz, water: false, hit: true, player: true });
          gone = true;
        }
      } else if (p.alive) {
        const d = segPointDist(ax, ay, az, b.x, b.y, b.z, p.x, p.y, p.z);
        if (d < p.radius) {
          this.hitPlayer(b.damage * p.fragility, b.owner === Owner.Aaa ? 'Shot down by anti-aircraft fire' : 'Shot down by machine-gun fire', 0.02, ax, az, false);
          this.events.push({ type: 'impact', x: b.x, y: b.y, z: b.z, water: false, hit: true, player: false });
          gone = true;
        } else if (b.splash > 0 && d < b.splash) {
          // Flak bursts beside the aircraft.
          this.hitPlayer(b.damage * 0.6 * (1 - d / b.splash) * p.fragility, 'Shot down by anti-aircraft fire', 0.02, ax, az, false);
          this.events.push({ type: 'flak', x: b.x, y: b.y, z: b.z });
          gone = true;
        } else if (d < 22 && !b.nearMissed) {
          b.nearMissed = true;
          this.events.push({ type: 'nearMiss' });
        }
      }
      if (!gone && b.y < 1800) {
        const s = this.surface(b.x, b.z);
        if (b.y < s) {
          if (Math.hypot(b.x - p.x, b.z - p.z) < 3000) this.events.push({ type: 'impact', x: b.x, y: s, z: b.z, water: s <= 0.01, hit: false, player: b.owner === Owner.Player });
          if (b.owner === Owner.Player && b.splash > 0) this.blast(b.x, s, b.z, b.damage * 0.35, b.splash, true);
          gone = true;
        }
      }
      if (!gone && b.life <= 0) {
        // Flak shells burst at the end of their fuse.
        if (b.owner === Owner.Aaa) this.events.push({ type: 'flak', x: b.x, y: b.y, z: b.z });
        gone = true;
      }
      if (!gone) list[n++] = b;
    }
    list.length = n;
  }

  private hitPlayer(amount: number, reason: string, crit: number, fromX: number, fromZ: number, missile: boolean): void {
    this.host.hit(amount, reason, crit);
    this.events.push({ type: 'playerHit', amount, fromX, fromZ, missile });
  }

  private updateMissiles(dt: number, p: PlayerState): void {
    const list = this.missiles;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      this.stepMissile(m, dt, p);
      if (m.alive) list[n++] = m;
    }
    list.length = n;
  }

  private stepMissile(m: Missile, dt: number, p: PlayerState): void {
    const spec = m.enemy ? ENEMY.sam : (this.loadout.missile ?? LOADOUTS.attack.missile!);
    const ax = m.x, ay = m.y, az = m.z;
    m.age += dt;
    if (m.age < m.delay) {
      // Dropping clear of the rail.
      m.vy -= G * dt;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.z += m.vz * dt;
      m.speed = Math.max(0, m.vx * m.dx + m.vy * m.dy + m.vz * m.dz);
    } else {
      const burning = m.age < m.delay + spec.burn;
      m.speed = burning ? Math.min(spec.speed, m.speed + spec.accel * dt) : Math.max(60, m.speed - 18 * dt);
      // Where to go: a lead point on the target.
      let tx = 0, ty = 0, tz = 0, tvx = 0, tvy = 0, tvz = 0, has = true;
      const t = m.target;
      if (t.kind === 'player' && p.alive) {
        tx = p.x; ty = p.y; tz = p.z; tvx = p.vx; tvy = p.vy; tvz = p.vz;
      } else if (t.kind === 'flare' && t.flare.age < t.flare.life) {
        const f = t.flare;
        tx = f.x; ty = f.y; tz = f.z; tvx = f.vx; tvy = f.vy; tvz = f.vz;
      } else if (t.kind === 'point') {
        tx = t.x; ty = t.y; tz = t.z;
      } else has = false;
      if (has) {
        const rx = tx - m.x, ry = ty - m.y, rz = tz - m.z;
        const range = Math.hypot(rx, ry, rz);
        const tgo = range / Math.max(80, m.speed);
        const lx = rx + tvx * tgo, ly = ry + tvy * tgo, lz = rz + tvz * tgo;
        const ll = Math.hypot(lx, ly, lz) || 1;
        // Turn toward it, as fast as the fins allow.
        const wx = lx / ll, wy = ly / ll, wz = lz / ll;
        const ang = Math.acos(Math.max(-1, Math.min(1, m.dx * wx + m.dy * wy + m.dz * wz)));
        const maxTurn = (spec.turn / Math.max(60, m.speed)) * dt * (m.age < m.delay + 0.35 ? 0.4 : 1);
        if (ang > 1e-5) {
          const k = Math.min(1, maxTurn / ang);
          const ndx = m.dx + (wx - m.dx) * k, ndy = m.dy + (wy - m.dy) * k, ndz = m.dz + (wz - m.dz) * k;
          const nl = Math.hypot(ndx, ndy, ndz) || 1;
          m.dx = ndx / nl;
          m.dy = ndy / nl;
          m.dz = ndz / nl;
        }
      }
      m.x += m.dx * m.speed * dt;
      m.y += m.dy * m.speed * dt;
      m.z += m.dz * m.speed * dt;
    }

    // Fuzes.
    if (m.enemy) {
      if (m.target.kind === 'player' && p.alive) {
        const S = ENEMY.sam;
        const d = segPointDist(ax, ay, az, m.x, m.y, m.z, p.x, p.y, p.z);
        // Burst when close, or as soon as it starts to pull away after a near pass.
        if (d < S.fuse || (m.minDist < S.fuse * 2.5 && d > m.minDist + 2)) {
          const k = Math.max(0, 1 - Math.max(0, Math.min(d, m.minDist) - p.radius) / (S.fuse * 2));
          if (k > 0) this.hitPlayer(S.damage * p.fragility * (0.45 + 0.55 * k), 'Shot down by a surface-to-air missile', 0.15 * k, m.x - m.dx * 50, m.z - m.dz * 50, true);
          this.detonate(m, 0.9, false);
          return;
        }
        m.minDist = Math.min(m.minDist, d);
      } else if (m.target.kind === 'flare') {
        const f = m.target.flare;
        if (Math.hypot(f.x - m.x, f.y - m.y, f.z - m.z) < 7) {
          this.detonate(m, 0.8, false);
          return;
        }
      }
    } else {
      const hit = this.segmentPart(ax, ay, az, m.x, m.y, m.z);
      if (hit) {
        m.x = ax + (m.x - ax) * hit.t;
        m.y = ay + (m.y - ay) * hit.t;
        m.z = az + (m.z - az) * hit.t;
        this.detonate(m, 1.2, true);
        return;
      }
      const t = m.target;
      if (t.kind === 'point' && segPointDist(ax, ay, az, m.x, m.y, m.z, t.x, t.y, t.z) < 2.5) {
        this.detonate(m, 1.2, true);
        return;
      }
    }
    const s = this.surface(m.x, m.z);
    if (m.y < s) {
      m.y = s + 0.5;
      this.detonate(m, m.enemy ? 0.9 : 1.2, !m.enemy);
      return;
    }
    if (m.age > spec.life) this.detonate(m, 0.7, !m.enemy);
  }

  private detonate(m: Missile, size: number, byPlayer: boolean): void {
    m.alive = false;
    this.events.push({ type: 'explosion', x: m.x, y: m.y, z: m.z, size });
    if (byPlayer) {
      const spec = this.loadout.missile ?? LOADOUTS.attack.missile!;
      this.blast(m.x, m.y, m.z, spec.damage, spec.radius, true);
    }
  }

  private updatePending(dt: number): void {
    const due: PendingBlast[] = [];
    const keep: PendingBlast[] = [];
    for (const b of this.pending) {
      b.t -= dt;
      (b.t > 0 ? keep : due).push(b);
    }
    this.pending = keep;
    // A blast may set off more; those join the queue for a later frame.
    for (const b of due) {
      this.events.push({ type: 'explosion', x: b.x, y: b.y, z: b.z, size: b.size });
      this.blast(b.x, b.y, b.z, b.damage, b.radius, true);
    }
  }

  /** Roughly normal noise, cheap. */
  private gauss(): number {
    return (this.rand() + this.rand() + this.rand() - 1.5) * 1.15;
  }
}

function segPointDist(ax: number, ay: number, az: number, bx: number, by: number, bz: number, px: number, py: number, pz: number): number {
  const sx = bx - ax, sy = by - ay, sz = bz - az;
  const ll = sx * sx + sy * sy + sz * sz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * sx + (py - ay) * sy + (pz - az) * sz) / ll));
  return Math.hypot(px - (ax + sx * t), py - (ay + sy * t), pz - (az + sz * t));
}
