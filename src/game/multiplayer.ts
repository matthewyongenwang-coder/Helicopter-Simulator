import { PoseBuffer } from '../net/interp';
import type { Incoming, NetClient } from '../net/netClient';
import { cleanName, encodePose, Flag, INTERP_DELAY, isEvent, isPose, SEND_RATE, type GameEvent, type PeerInfo } from '../net/protocol';
import { AIRCRAFT } from '../data/aircraft';
import { PVP } from '../data/weapons';
import { RemoteAircraft, type RemotePose } from '../render/remoteView';
import { Owner, type PilotTarget } from './combat';
import type { Game } from './game';

/**
 * Multiplayer on top of one Game: sends this aircraft's pose and what it
 * wrecks, and draws everyone else. Each pilot flies their own aircraft and
 * runs their own compounds (which shoot only at them); what is shared is where
 * everyone is and what has been destroyed, so the wrecks are the same for all.
 *
 * Pilots can fight. The shooter's game decides hits against where it draws the
 * other aircraft and sends them; the target's game applies the damage and,
 * when it goes down, says who did it. Each game also checks its own aircraft
 * against the others for mid-air collisions.
 */

export interface Peer {
  id: number;
  name: string;
  buf: PoseBuffer;
  view: RemoteAircraft | null;
  /** Latest drawn position and heading, for the minimap and name tags. */
  x: number;
  y: number;
  z: number;
  heading: number;
  /** Has a pose to draw. */
  shown: boolean;
  destroyed: boolean;
  onGround: boolean;
  rotorN: number;
  /** Rotor disc radius for collisions, m. */
  discR: number;
  gunTimer: number;
  swapTimer: number;
  /** What combat aims at and hits. */
  target: PilotTarget;
}

/** Pilots further than this are not drawn (they would be specks); they still show on the minimap. */
const DRAW_RANGE = 6000;

export class Multiplayer {
  readonly peers = new Map<number, Peer>();
  /** Short notices for the HUD (joins, leaves, connection). */
  onNotice: ((text: string, kind: 'ok' | 'info' | 'warn') => void) | null = null;
  private sendTimer = 0;
  private gunRecent = 0;
  /** Hits scored on each pilot, summed until the next send. */
  private hitAcc = new Map<number, { a: number; c: number; m: boolean }>();
  private hitTimer = 0;
  /** Missiles locked on this aircraft by other pilots, until they should have arrived. */
  private threats: { from: number; until: number }[] = [];
  private lastHit: { id: number; at: number } | null = null;
  private wasDown = false;
  private readonly tmp = new Array<number>(10).fill(0);
  private readonly pose: RemotePose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, rotorN: 0, powered: false, destroyed: false, rotorOk: true, tailRotorOk: true };

  constructor(private game: Game, readonly client: NetClient) {}

  /** Pilots in the room, this one included. */
  get count(): number {
    return this.peers.size + 1;
  }

  update(dt: number): void {
    const now = performance.now() / 1000;
    for (const m of this.client.take()) this.receive(m);
    this.forwardLocalEvents(dt);
    this.sendHits(dt);
    this.sendPose(dt);
    this.drawPeers(dt, now - INTERP_DELAY);
    this.collide(dt);
    this.watchOwnAircraft(now);
  }

  /** Pilots shown, for combat to aim at and hit. */
  private refreshTargets(): void {
    const list: PilotTarget[] = [];
    for (const p of this.peers.values()) if (p.shown) list.push(p.target);
    this.game.combat.pilots = list;
  }

  /** Leave the room and remove everyone else's aircraft. */
  dispose(): void {
    this.client.close();
    this.clearPeers();
  }

  // ---- Incoming -----------------------------------------------------------------------

  private receive({ at, msg }: Incoming): void {
    switch (msg.t) {
      case 'welcome': {
        this.clearPeers();
        for (const p of msg.peers) this.addPeer(p);
        const c = this.game.combat;
        for (const key of msg.parts) {
          const k = key.lastIndexOf(':');
          const i = Number(key.slice(k + 1));
          if (k > 0 && Number.isInteger(i)) c.applyRemotePart(key.slice(0, k), i);
        }
        msg.cmps.forEach((id, k) => c.applyRemoteCompound(id, Number(msg.ages?.[k]) || 0));
        const others = msg.peers.length;
        this.onNotice?.(others ? `Online · ${others} other pilot${others === 1 ? '' : 's'} here` : 'Online · waiting for other pilots', 'ok');
        break;
      }
      case 'join':
        this.onNotice?.(`${this.addPeer(msg).name} joined`, 'info');
        break;
      case 'leave': {
        const p = this.peers.get(msg.id);
        if (p) {
          this.removePeer(p);
          this.onNotice?.(`${p.name} left`, 'info');
        }
        break;
      }
      case 'lost':
        this.clearPeers();
        this.onNotice?.('Connection lost · reconnecting', 'warn');
        break;
      case 'full':
        this.onNotice?.('That room is full', 'warn');
        break;
      case 'p':
        if (isPose(msg)) (this.peers.get(msg.from) ?? this.addPeer({ id: msg.from, name: 'Pilot' })).buf.push(at, msg);
        break;
      case 'ev':
        if (isEvent(msg)) this.applyEvent(msg.e, msg.from);
        break;
      default:
        break;
    }
  }

  private applyEvent(e: GameEvent, from: number): void {
    const g = this.game;
    switch (e.k) {
      case 'part': g.combat.applyRemotePart(e.id, e.i); break;
      case 'cmp': g.combat.applyRemoteCompound(e.id); break;
      case 'boom': g.injected.push({ type: 'explosion', x: e.x, y: e.y, z: e.z, size: Math.min(4, Math.max(0.1, e.s)), remote: true }); break;
      case 'launch': {
        g.injected.push({ type: 'missileLaunch', enemy: false, x: e.x, y: e.y, z: e.z, remote: true });
        if (e.at === this.client.id && !g.sim.heli.destroyed) {
          // Their game flies the missile; warn for about as long as it could take to get here.
          const h = g.sim.heli.pos;
          const d = Math.hypot(e.x - h.x, e.y - h.y, e.z - h.z);
          this.threats.push({ from, until: performance.now() / 1000 + Math.min(14, 1.5 + d / 260) });
        }
        break;
      }
      case 'flare': g.combat.remoteFlare(from, e.x, e.y, e.z); break;
      case 'hit': if (e.to === this.client.id) this.takeHit(e, from); break;
      case 'kill': {
        const victim = this.peers.get(from)?.name ?? 'Pilot';
        const mine = e.by === this.client.id;
        const killer = mine ? 'You' : this.peers.get(e.by)?.name ?? 'Pilot';
        this.onNotice?.(`${killer} shot down ${victim}`, mine ? 'ok' : 'info');
        break;
      }
    }
  }

  /** Another pilot's shots hit this aircraft. */
  private takeHit(e: Extract<GameEvent, { k: 'hit' }>, from: number): void {
    const g = this.game, h = g.sim.heli;
    if (h.destroyed) return;
    const peer = this.peers.get(from);
    const amount = Math.min(PVP.maxHit, e.a) * g.aircraft.damage.fragility;
    h.takeHit(amount, `Shot down by ${peer?.name ?? 'another pilot'}`, e.c);
    g.injected.push({ type: 'playerHit', amount, fromX: peer?.x ?? h.pos.x, fromZ: peer?.z ?? h.pos.z, missile: e.m });
    this.lastHit = { id: from, at: performance.now() / 1000 };
    if (e.m) {
      const k = this.threats.findIndex((t) => t.from === from);
      if (k >= 0) this.threats.splice(k, 1);
    }
  }

  /** Missile warnings, and telling everyone who shot this aircraft down. */
  private watchOwnAircraft(now: number): void {
    const g = this.game, down = g.sim.heli.destroyed;
    this.threats = down ? [] : this.threats.filter((t) => t.until > now);
    g.combat.extraIncoming = this.threats.length;
    if (down && !this.wasDown) {
      const hit = this.lastHit;
      if (hit && now - hit.at < PVP.killCredit && this.peers.has(hit.id)) this.client.send({ t: 'ev', e: { k: 'kill', by: hit.id } });
    }
    if (!down && this.wasDown) this.lastHit = null;
    this.wasDown = down;
  }

  /** Hits on other pilots go out in small batches rather than one message per round. */
  private sendHits(dt: number): void {
    const c = this.game.combat;
    let urgent = false;
    for (const hit of c.pvpHits) {
      const acc = this.hitAcc.get(hit.id) ?? { a: 0, c: 0, m: false };
      acc.a += hit.amount;
      acc.c = Math.max(acc.c, hit.crit);
      acc.m ||= hit.missile;
      urgent ||= hit.missile;
      this.hitAcc.set(hit.id, acc);
    }
    c.pvpHits.length = 0;
    this.hitTimer -= dt;
    if (this.hitAcc.size === 0 || (this.hitTimer > 0 && !urgent)) return;
    this.hitTimer = PVP.hitBatch;
    for (const [to, acc] of this.hitAcc) {
      if (!this.peers.has(to)) continue;
      // Split anything bigger than one message may carry.
      let left = acc.a;
      while (left > 1e-4) {
        const a = Math.min(PVP.maxHit, left);
        left -= a;
        this.client.send({ t: 'ev', e: { k: 'hit', to, a: Math.round(a * 1e4) / 1e4 || 1e-4, c: Math.round(acc.c * 100) / 100, m: acc.m } });
      }
    }
    this.hitAcc.clear();
  }

  /**
   * Touching another aircraft: rotor discs meeting, or a hard knock, wrecks
   * this one (their game does the same for theirs). Two aircraft both resting
   * on the ground only nudge apart, so a shared helipad is safe.
   */
  private collide(dt: number): void {
    const g = this.game, h = g.sim.heli;
    if (h.destroyed || g.mode !== 'fly' || g.paused || !g.ready || g.flightTime < PVP.spawnGrace) return;
    const myR = g.aircraft.rotor.diameter * 0.42;
    const ground = h.tel.onGround;
    for (const p of this.peers.values()) {
      if (!p.shown || (ground && p.onGround)) continue;
      const dx = h.pos.x - p.x, dy = h.pos.y - p.y, dz = h.pos.z - p.z;
      const d = Math.hypot(dx, dy, dz), r = myR + p.discR;
      if (d >= r || d < 1e-3) continue;
      const nx = dx / d, ny = dy / d, nz = dz / d;
      const t = p.target;
      const closing = -((h.vel.x - t.vx) * nx + (h.vel.y - t.vy) * ny + (h.vel.z - t.vz) * nz);
      if (closing > PVP.crashSpeed || h.rotorN > 0.4 || p.rotorN > 0.4) {
        h.takeHit(2, `Mid-air collision with ${p.name}`, 1);
        return;
      }
      // Rotors stopped and barely moving: push apart.
      const push = Math.min(4, (r - d) * 3) * dt * 10;
      h.vel.x += nx * push;
      h.vel.z += nz * push;
    }
  }

  private addPeer(p: PeerInfo): Peer {
    // The relay cleans names too; this keeps the game safe from any server it is pointed at.
    const name = cleanName(p.name);
    const old = this.peers.get(p.id);
    if (old) {
      old.name = name;
      return old;
    }
    const peer: Peer = {
      id: p.id, name, buf: new PoseBuffer(), view: null, x: 0, y: 0, z: 0, heading: 0, shown: false, destroyed: false,
      onGround: false, rotorN: 0, discR: 5, gunTimer: 0, swapTimer: 0,
      target: { id: p.id, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, radius: 3, alive: false },
    };
    this.peers.set(p.id, peer);
    return peer;
  }

  private removePeer(p: Peer): void {
    p.view?.dispose();
    this.peers.delete(p.id);
    this.hitAcc.delete(p.id);
    this.refreshTargets();
  }

  private clearPeers(): void {
    for (const p of [...this.peers.values()]) this.removePeer(p);
  }

  // ---- Outgoing -----------------------------------------------------------------------

  /** What this aircraft wrecked or set off last frame goes to everyone else. */
  private forwardLocalEvents(dt: number): void {
    this.gunRecent = Math.max(0, this.gunRecent - dt);
    for (const e of this.game.combatEvents) {
      let out: GameEvent | null = null;
      switch (e.type) {
        case 'gunFire': this.gunRecent = 0.15; break;
        case 'partDestroyed': if (!e.remote) out = { k: 'part', id: e.compound.site.id, i: e.part.index }; break;
        case 'compoundDestroyed': if (!e.remote) out = { k: 'cmp', id: e.compound.site.id }; break;
        case 'explosion': if (!e.remote) out = { k: 'boom', x: r1(e.x), y: r1(e.y), z: r1(e.z), s: e.size }; break;
        case 'missileLaunch': if (!e.remote && !e.enemy) out = { k: 'launch', x: r1(e.x), y: r1(e.y), z: r1(e.z), ...(e.at ? { at: e.at } : {}) }; break;
        case 'flare': if (!e.remote) out = { k: 'flare', x: r1(e.x), y: r1(e.y), z: r1(e.z) }; break;
        default: break;
      }
      if (out) this.client.send({ t: 'ev', e: out });
    }
  }

  private sendPose(dt: number): void {
    const g = this.game;
    this.sendTimer -= dt;
    if (this.sendTimer > 0 || !g.ready) return;
    this.sendTimer += 1 / SEND_RATE;
    if (this.sendTimer < 0) this.sendTimer = 0;
    const h = g.sim.heli, p = g.renderPos, q = g.renderQ;
    let f = 0;
    if (this.gunRecent > 0) f |= Flag.Gun;
    if (g.landingLightOn) f |= Flag.Light;
    if (h.destroyed) f |= Flag.Destroyed;
    if (h.engine !== 'off' || h.rotorN > 0.05) f |= Flag.Powered;
    if (h.rotorOk) f |= Flag.RotorOk;
    if (h.tailRotorOk) f |= Flag.TailOk;
    if (h.tel.onGround) f |= Flag.OnGround;
    // Parked in the menu: no velocity, so others do not see it drift.
    const still = g.mode !== 'fly' || g.paused;
    this.client.send(encodePose(g.aircraft.id, p.x, p.y, p.z, q.x, q.y, q.z, q.w, still ? 0 : h.vel.x, still ? 0 : h.vel.y, still ? 0 : h.vel.z, h.rotorN, f));
  }

  // ---- Drawing ------------------------------------------------------------------------

  private drawPeers(dt: number, t: number): void {
    this.drawPeersInner(dt, t);
    this.refreshTargets();
  }

  private drawPeersInner(dt: number, t: number): void {
    const g = this.game, s = this.tmp, pose = this.pose;
    const me = g.renderPos;
    const time = g.engine.timeUniform.value;
    for (const peer of this.peers.values()) {
      const sample = peer.buf.sample(t, s);
      if (!sample) {
        peer.shown = false;
        if (peer.view) peer.view.visible = false;
        continue;
      }
      peer.shown = true;
      peer.x = s[0]; peer.y = s[1]; peer.z = s[2];
      // Nose direction: the body's −z axis turned into the world.
      const qx = s[3], qy = s[4], qz = s[5], qw = s[6];
      const fx = -2 * (qx * qz + qw * qy), fz = -(1 - 2 * (qx * qx + qy * qy));
      peer.heading = Math.atan2(fx, -fz);
      peer.destroyed = (sample.f & Flag.Destroyed) !== 0;
      peer.onGround = (sample.f & Flag.OnGround) !== 0;
      peer.rotorN = Math.max(0, Math.min(1.2, sample.r));
      const ac = Object.hasOwn(AIRCRAFT, sample.a) ? AIRCRAFT[sample.a] : AIRCRAFT.medium;
      peer.discR = ac.rotor.diameter * 0.42;
      const tg = peer.target;
      tg.x = s[0]; tg.y = s[1]; tg.z = s[2]; tg.vx = s[7]; tg.vy = s[8]; tg.vz = s[9];
      tg.radius = Math.max(2.4, ac.body.length * 0.28);
      tg.alive = !peer.destroyed;
      const dist = Math.hypot(s[0] - me.x, s[1] - me.y, s[2] - me.z);
      if (dist > DRAW_RANGE) {
        if (peer.view) peer.view.visible = false;
        continue;
      }
      peer.swapTimer -= dt;
      if (!peer.view) peer.view = new RemoteAircraft(g.engine, sample.a);
      else if (sample.a !== peer.view.aircraftId && peer.swapTimer <= 0) {
        // Building a model takes a few milliseconds: at most one swap a second per pilot.
        peer.swapTimer = 1;
        peer.view.setAircraft(sample.a);
      }
      peer.view.visible = true;
      pose.x = s[0]; pose.y = s[1]; pose.z = s[2];
      pose.qx = qx; pose.qy = qy; pose.qz = qz; pose.qw = qw;
      pose.rotorN = Math.max(0, Math.min(1.2, sample.r));
      pose.powered = (sample.f & Flag.Powered) !== 0;
      pose.destroyed = peer.destroyed;
      pose.rotorOk = (sample.f & Flag.RotorOk) !== 0;
      pose.tailRotorOk = (sample.f & Flag.TailOk) !== 0;
      peer.view.update(dt, pose, g.sky.daylight, time);
      // Their guns: muzzle flashes and distant gunfire.
      peer.gunTimer -= dt;
      if ((sample.f & Flag.Gun) && !peer.destroyed && peer.gunTimer <= 0) {
        peer.gunTimer = 0.09;
        g.injected.push({ type: 'enemyFire', x: s[0] + fx * 3, y: s[1] - 0.6, z: s[2] + fz * 3, kind: Owner.Mg, dist, remote: true });
      }
    }
  }
}

const r1 = (v: number) => Math.round(v * 10) / 10;
