import { SUPPLY } from '../data/weapons';
import type { Helicopter } from '../sim/helicopter';
import { suppliesNear, type SupplySite } from '../world/supply';
import type { World } from '../world/world';
import type { Combat } from './combat';

/** What the crew at the nearest supply point is doing, for the HUD. */
export interface SupplyStatus {
  /** Nearest supply point and the ground distance to its centre. */
  site: SupplySite | null;
  dist: number;
  /** Inside the landing zone. */
  inZone: boolean;
  /** Landed and settled: the crew is at work (or done). */
  serving: boolean;
  repairing: boolean;
  refuelling: boolean;
  rearming: boolean;
  /** Overall progress of this visit, 0–1. */
  progress: number;
}

export type SupplyEvent = { type: 'started'; site: SupplySite } | { type: 'complete'; site: SupplySite };

/** How far to look for supply points for the HUD marker and minimap. */
const SEARCH = 30000;

/**
 * Supply points near the aircraft, and the ground crew: land inside a zone,
 * settle, and the airframe is patched, the tanks filled and the weapons
 * reloaded, a little each second, for as long as the aircraft stays put.
 */
export class Resupply {
  /** Supply points near the aircraft, nearest first (the home pad included). */
  sites: SupplySite[] = [];
  /** The start helipad doubles as a supply point. */
  home: SupplySite | null = null;
  readonly status: SupplyStatus = { site: null, dist: Infinity, inZone: false, serving: false, repairing: false, refuelling: false, rearming: false, progress: 0 };
  events: SupplyEvent[] = [];

  private cache = new Map<string, SupplySite | null>();
  private refreshTimer = 0;
  private refreshedAt = { x: Infinity, z: Infinity };
  private settled = 0;
  private wasServing = false;
  private done = false;
  /** What was missing on arrival, as fractions, for the progress bar. */
  private need = [0, 0, 0, 0, 0];

  constructor(private world: World) {}

  setHome(x: number, y: number, z: number, heading: number): void {
    this.home = { id: 'home', name: 'Home heliport', x, y, z, yaw: heading, field: false };
    this.refreshedAt.x = Infinity;
  }

  /** Every supply point within `range`, nearest first. */
  near(x: number, z: number, range: number): SupplySite[] {
    if (this.cache.size > 800) this.cache.clear();
    const out = suppliesNear(this.world, x, z, range, this.cache);
    if (this.home && Math.hypot(this.home.x - x, this.home.z - z) <= range) out.push(this.home);
    return out.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
  }

  /** Forget the visit in progress (a fresh spawn). */
  reset(): void {
    this.settled = 0;
    this.wasServing = false;
    this.done = false;
    this.events.length = 0;
    this.status.serving = this.status.inZone = false;
  }

  takeEvents(): SupplyEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  update(dt: number, heli: Helicopter, combat: Combat): void {
    const x = heli.pos.x, z = heli.pos.z, S = this.status;
    // Re-list the sites now and then; generating cells is not free.
    this.refreshTimer -= dt;
    if (this.refreshTimer <= 0 && Math.hypot(x - this.refreshedAt.x, z - this.refreshedAt.z) > 500) {
      this.refreshTimer = 1;
      this.refreshedAt.x = x;
      this.refreshedAt.z = z;
      this.sites = this.near(x, z, SEARCH);
    }
    let best: SupplySite | null = null, bestD = Infinity;
    for (const s of this.sites) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bestD) {
        best = s;
        bestD = d;
      }
    }
    S.site = best;
    S.dist = bestD;
    S.inZone = !!best && bestD < SUPPLY.radius && Math.abs(heli.pos.y - best.y) < 40;

    const t = heli.tel;
    const landed = S.inZone && !heli.destroyed && t.onGround && t.gearLoad > 0.4 && heli.vel.len() < SUPPLY.maxSpeed;
    this.settled = landed && dt > 0 ? this.settled + dt : landed ? this.settled : 0;
    S.serving = this.settled >= SUPPLY.settle;
    S.repairing = S.refuelling = S.rearming = false;
    if (!S.serving || !best) {
      this.wasServing = false;
      this.done = false;
      return;
    }

    if (!this.wasServing) {
      this.wasServing = true;
      this.need = this.missing(heli, combat);
      this.done = this.need.every((v) => v <= 1e-6);
      if (!this.done) this.events.push({ type: 'started', site: best });
    }

    if (heli.health < 1) {
      heli.repair(SUPPLY.repairRate * dt);
      S.repairing = true;
    }
    if (heli.fuel < heli.fuelLimit() - 0.01) {
      heli.refuel((heli.ac.data.fuel.capacity / SUPPLY.refuelTime) * dt);
      S.refuelling = true;
    }
    if (!combat.fullyArmed) {
      combat.rearm(dt, SUPPLY.gunTime, SUPPLY.flareTime, SUPPLY.missileEvery);
      S.rearming = true;
    }

    // Progress: the share of what was missing on arrival that has been put back.
    const now = this.missing(heli, combat);
    let total = 0, left = 0;
    for (let i = 0; i < now.length; i++) {
      total += this.need[i];
      left += Math.min(this.need[i], now[i]);
    }
    S.progress = total > 1e-6 ? 1 - left / total : 1;

    if (!this.done && now.every((v) => v <= 1e-6)) {
      this.done = true;
      S.progress = 1;
      this.events.push({ type: 'complete', site: best });
    }
  }

  /** Fractions still to fill: airframe, fuel, gun, missiles, flares. */
  private missing(heli: Helicopter, combat: Combat): number[] {
    const L = combat.loadout;
    const gunMax = L.gun?.ammo ?? 0, railMax = L.missile?.rails.length ?? 0, cap = heli.ac.data.fuel.capacity;
    const fuel = heli.fuelLimit() - heli.fuel;
    return [
      Math.max(0, 1 - heli.health),
      fuel > 0.01 ? fuel / cap : 0,
      gunMax ? (gunMax - combat.gunAmmo) / gunMax : 0,
      railMax ? (railMax - combat.missilesLeft) / railMax : 0,
      L.flares ? (L.flares - combat.flaresLeft) / L.flares : 0,
    ];
  }
}
