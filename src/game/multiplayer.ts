import { PoseBuffer } from '../net/interp';
import type { Incoming, NetClient } from '../net/netClient';
import { cleanName, encodePose, Flag, INTERP_DELAY, isEvent, isPose, SEND_RATE, type GameEvent, type PeerInfo } from '../net/protocol';
import { RemoteAircraft, type RemotePose } from '../render/remoteView';
import { Owner } from './combat';
import type { Game } from './game';

/**
 * Multiplayer on top of one Game: sends this aircraft's pose and what it
 * wrecks, and draws everyone else. Each pilot flies their own aircraft and
 * runs their own compounds (which shoot only at them); what is shared is where
 * everyone is and what has been destroyed, so the wrecks are the same for all.
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
  gunTimer: number;
  swapTimer: number;
}

/** Pilots further than this are not drawn (they would be specks); they still show on the minimap. */
const DRAW_RANGE = 6000;

export class Multiplayer {
  readonly peers = new Map<number, Peer>();
  /** Short notices for the HUD (joins, leaves, connection). */
  onNotice: ((text: string, kind: 'ok' | 'info' | 'warn') => void) | null = null;
  private sendTimer = 0;
  private gunRecent = 0;
  private readonly tmp = new Array<number>(10).fill(0);
  private readonly pose: RemotePose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, rotorN: 0, powered: false, destroyed: false, rotorOk: true, tailRotorOk: true };

  constructor(private game: Game, readonly client: NetClient) {}

  /** Pilots in the room, this one included. */
  get count(): number {
    return this.peers.size + 1;
  }

  update(dt: number): void {
    for (const m of this.client.take()) this.receive(m);
    this.forwardLocalEvents(dt);
    this.sendPose(dt);
    this.drawPeers(dt, performance.now() / 1000 - INTERP_DELAY);
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
        if (isEvent(msg)) this.applyEvent(msg.e);
        break;
      default:
        break;
    }
  }

  private applyEvent(e: GameEvent): void {
    const g = this.game;
    switch (e.k) {
      case 'part': g.combat.applyRemotePart(e.id, e.i); break;
      case 'cmp': g.combat.applyRemoteCompound(e.id); break;
      case 'boom': g.injected.push({ type: 'explosion', x: e.x, y: e.y, z: e.z, size: Math.min(4, Math.max(0.1, e.s)), remote: true }); break;
      case 'launch': g.injected.push({ type: 'missileLaunch', enemy: false, x: e.x, y: e.y, z: e.z, remote: true }); break;
      case 'flare': g.injected.push({ type: 'flare', x: e.x, y: e.y, z: e.z, remote: true }); break;
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
    const peer: Peer = { id: p.id, name, buf: new PoseBuffer(), view: null, x: 0, y: 0, z: 0, heading: 0, shown: false, destroyed: false, gunTimer: 0, swapTimer: 0 };
    this.peers.set(p.id, peer);
    return peer;
  }

  private removePeer(p: Peer): void {
    p.view?.dispose();
    this.peers.delete(p.id);
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
        case 'missileLaunch': if (!e.remote && !e.enemy) out = { k: 'launch', x: r1(e.x), y: r1(e.y), z: r1(e.z) }; break;
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
    // Parked in the menu: no velocity, so others do not see it drift.
    const still = g.mode !== 'fly' || g.paused;
    this.client.send(encodePose(g.aircraft.id, p.x, p.y, p.z, q.x, q.y, q.z, q.w, still ? 0 : h.vel.x, still ? 0 : h.vel.y, still ? 0 : h.vel.z, h.rotorN, f));
  }

  // ---- Drawing ------------------------------------------------------------------------

  private drawPeers(dt: number, t: number): void {
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
