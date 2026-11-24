/**
 * The multiplayer wire format, shared by the game and the relay. Plain JSON
 * with short keys: a pose update is about 150 bytes and goes out 12 times a
 * second, so a pilot costs under 2 KB/s.
 *
 * The relay is dumb: it stamps each message with the sender's id and passes
 * it on. It only reads `ev` messages, to remember which compound parts have
 * been destroyed so that a pilot who joins later sees the same wrecks.
 */

/** Pose updates per second. */
export const SEND_RATE = 12;
/** Other aircraft are drawn this far in the past, so there are always two updates to blend between. */
export const INTERP_DELAY = 0.18;
/** Most pilots in one room. */
export const ROOM_LIMIT = 16;
/** Longest message the relay accepts, in characters. */
export const MAX_MESSAGE = 2048;
/** Longest callsign. */
export const NAME_MAX = 16;
/**
 * Seconds a fallen compound stays down before it is rebuilt. Must match
 * COMPOUNDS.respawnTime (a test checks); the relay forgets a compound's wreck after this.
 */
export const WRECK_MEMORY = 120;

/** Bits in a pose update's `f` field. */
export const Flag = {
  Gun: 1,
  Light: 2,
  Destroyed: 4,
  Powered: 8,
  RotorOk: 16,
  TailOk: 32,
  /** Resting on its gear. */
  OnGround: 64,
} as const;

/** A pilot's pose: position, rotation, velocity, rotor speed and state flags. */
export interface PoseMsg {
  t: 'p';
  /** Aircraft id. */
  a: string;
  /** x, y, z, qx, qy, qz, qw, vx, vy, vz. */
  s: number[];
  /** Rotor speed, 0–1.1. */
  r: number;
  f: number;
}

/** Something that happened in one pilot's world that the others should see. */
export type GameEvent =
  | { k: 'part'; id: string; i: number }
  | { k: 'cmp'; id: string }
  | { k: 'boom'; x: number; y: number; z: number; s: number }
  /** A missile launch; `at` is the pilot it is locked on to, so they get a warning. */
  | { k: 'launch'; x: number; y: number; z: number; at?: number }
  /** The sender's shots hit pilot `to` for `a` of an airframe (`c` tail-rotor chance, `m` a missile). */
  | { k: 'hit'; to: number; a: number; c: number; m: boolean }
  /** The sender was shot down by pilot `by`. */
  | { k: 'kill'; by: number }
  | { k: 'flare'; x: number; y: number; z: number };

export interface EventMsg {
  t: 'ev';
  e: GameEvent;
}

export interface HelloMsg {
  t: 'hi';
  name: string;
}

export type ClientMsg = PoseMsg | EventMsg | HelloMsg;

export interface PeerInfo {
  id: number;
  name: string;
}

/** Sent to a pilot when they connect: their id, who else is here, and what is already wrecked. */
export interface WelcomeMsg {
  t: 'welcome';
  id: number;
  peers: PeerInfo[];
  /** Destroyed parts as "compoundId:partIndex". */
  parts: string[];
  /** Destroyed compound ids, and how many seconds ago each fell. */
  cmps: string[];
  ages: number[];
}

export interface JoinMsg {
  t: 'join';
  id: number;
  name: string;
}

export interface LeaveMsg {
  t: 'leave';
  id: number;
}

export interface FullMsg {
  t: 'full';
}

/** A client message passed on by the relay, stamped with the sender. */
export type RelayedMsg = (PoseMsg | EventMsg) & { from: number };

export type ServerMsg = WelcomeMsg | JoinMsg | LeaveMsg | FullMsg | RelayedMsg;

/** One open room in the lobby list (`GET /lobbies` on the relay). */
export interface LobbyInfo {
  /** Room code, which is the world seed ("K7M2-QX9"). */
  room: string;
  pilots: number;
  /** Callsigns of the pilots in it. */
  names: string[];
}

/** A room drops off the lobby list if it has not reported for this long, s (it reports every minute while occupied). */
export const LOBBY_STALE = 150;

/** True when a decoded lobby list entry is well formed. */
export function isLobbyInfo(v: unknown): v is LobbyInfo {
  const l = v as LobbyInfo;
  return !!l && typeof l.room === 'string' && l.room.length <= 24 && Number.isInteger(l.pilots) && l.pilots > 0 && Array.isArray(l.names) && l.names.every((n) => typeof n === 'string');
}

/** Trim a callsign to printable characters and a sane length. */
export function cleanName(name: unknown): string {
  const s = typeof name === 'string' ? name.replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, NAME_MAX) : '';
  return s || 'Pilot';
}

/** Room codes are the world seed as shown in the menu ("K7M2-QX9"). */
export function cleanRoom(room: string): string {
  return room.toUpperCase().replace(/[^0-9A-Z-]/g, '').slice(0, 24);
}

const round = (v: number, k: number) => Math.round(v * k) / k;

/** Pack a pose for the wire: centimetres, and rotations to 4 decimals. */
export function encodePose(a: string, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, vx: number, vy: number, vz: number, rotor: number, flags: number): PoseMsg {
  return {
    t: 'p',
    a,
    s: [round(x, 100), round(y, 100), round(z, 100), round(qx, 1e4), round(qy, 1e4), round(qz, 1e4), round(qw, 1e4), round(vx, 100), round(vy, 100), round(vz, 100)],
    r: round(rotor, 1000),
    f: flags,
  };
}

/** True when a decoded message looks like a valid pose (guards against junk from the network). */
export function isPose(m: unknown): m is PoseMsg {
  const p = m as PoseMsg;
  return !!p && p.t === 'p' && typeof p.a === 'string' && p.a.length < 24 && Array.isArray(p.s) && p.s.length === 10 && p.s.every(Number.isFinite) && Number.isFinite(p.r) && Number.isFinite(p.f);
}

const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) < 1e6;

/** True when a decoded message is a well-formed game event. */
export function isEvent(m: unknown): m is EventMsg {
  const e = (m as EventMsg)?.e as GameEvent | undefined;
  if (!e || (m as EventMsg).t !== 'ev') return false;
  switch (e.k) {
    case 'part': return typeof e.id === 'string' && e.id.length < 64 && Number.isInteger(e.i) && e.i >= 0 && e.i < 256;
    case 'cmp': return typeof e.id === 'string' && e.id.length < 64;
    case 'boom': return [e.x, e.y, e.z, e.s].every(Number.isFinite);
    case 'launch': return [e.x, e.y, e.z].every(Number.isFinite) && (e.at === undefined || isId(e.at));
    case 'flare': return [e.x, e.y, e.z].every(Number.isFinite);
    case 'hit': return isId(e.to) && Number.isFinite(e.a) && e.a > 0 && e.a <= 1 && Number.isFinite(e.c) && e.c >= 0 && e.c <= 1 && typeof e.m === 'boolean';
    case 'kill': return isId(e.by);
    default: return false;
  }
}
