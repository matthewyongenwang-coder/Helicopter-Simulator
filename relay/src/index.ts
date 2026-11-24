import { DurableObject } from 'cloudflare:workers';
import { cleanName, cleanRoom, isEvent, isPose, LOBBY_STALE, MAX_MESSAGE, ROOM_LIMIT, WRECK_MEMORY, type LobbyInfo, type PeerInfo, type ServerMsg } from '../../src/net/protocol';

/**
 * The multiplayer relay. One Durable Object per room; a room is a world seed.
 * Each pilot holds a WebSocket to the room, which stamps their messages with
 * their id and passes them to everyone else. It runs no physics: every pilot
 * flies their own aircraft and the world is the same for all of them because
 * it comes from the seed.
 *
 * The room remembers which compound parts have been destroyed, so a pilot who
 * joins later sees the same wrecks. A fallen compound is rebuilt after
 * WRECK_MEMORY seconds, so the room forgets it then. When the last pilot leaves,
 * it forgets everything.
 *
 * Rooms with pilots in them tell the single Lobby object who is there (on every
 * join and leave, and once a minute while occupied), and `GET /lobbies` lists
 * them, so the menu can show open rooms to join from anywhere.
 */

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  LOBBY: DurableObjectNamespace<Lobby>;
  /** Optional comma-separated list of sites allowed to connect, e.g. "https://my-game.vercel.app". Unset allows any. */
  ALLOWED_ORIGINS?: string;
}

/** Per pilot, per second: poses beyond this are dropped, events beyond this are dropped, and past FLOOD the pilot is cut off. */
const POSE_RATE = 30;
const EVENT_RATE = 120;
const FLOOD = 400;
/** Most wrecks a room remembers (a compound has a few dozen parts). */
const MAX_PARTS = 5000;
const MAX_CMPS = 500;
/** How often an occupied room re-reports to the lobby, ms. */
const LOBBY_REFRESH = 60_000;
/** Most rooms the lobby list returns. */
const LOBBY_MAX = 50;

const lobbyOf = (env: Env) => env.LOBBY.get(env.LOBBY.idFromName('lobby'));

interface Pilot {
  id: number;
  name: string;
  /** The room's code: a Durable Object does not know the name it was made from. */
  room: string;
  /** Has said hello and been welcomed. */
  ready: boolean;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response('Helicopter Simulator relay\n', { headers: { 'content-type': 'text/plain' } });
    const allowed = env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.get('Origin') ?? '';
    const originOk = !allowed?.length || allowed.includes(origin);
    if (url.pathname === '/lobbies') {
      // Read by the game page from another origin, so it needs CORS.
      const headers = {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': allowed?.length ? origin : '*',
        'access-control-allow-methods': 'GET',
        vary: 'Origin',
      };
      if (!originOk) return new Response('Forbidden', { status: 403 });
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers });
      return new Response(JSON.stringify(await lobbyOf(env).list()), { headers });
    }
    const m = url.pathname.match(/^\/room\/([^/]{1,40})$/);
    if (!m) return new Response('Not found', { status: 404 });
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    if (!originOk) return new Response('Forbidden', { status: 403 });
    const room = cleanRoom(decodeURIComponent(m[1]));
    if (!room) return new Response('Bad room', { status: 400 });
    // The room object is told its own code (a Durable Object does not know the name it came from).
    const headers = new Headers(req.headers);
    headers.set('X-Room', room);
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(new Request(req, { headers }));
  },
};

export class Room extends DurableObject<Env> {
  private parts = new Set<string>();
  /** Fallen compounds and when they fell (ms). */
  private cmps = new Map<string, number>();
  /** Message counts in the current one-second window, per socket (reset if the room sleeps, which is fine). */
  private rates = new Map<WebSocket, { at: number; poses: number; events: number; all: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The room may have slept (hibernated) with pilots still connected: reload the wrecks.
    ctx.blockConcurrencyWhile(async () => {
      this.parts = new Set((await ctx.storage.get<string[]>('parts')) ?? []);
      const saved = await ctx.storage.get<[string, number][]>('cmps');
      this.cmps = new Map(Array.isArray(saved) ? saved.filter((e) => Array.isArray(e) && typeof e[1] === 'number') : []);
    });
  }

  async fetch(req: Request): Promise<Response> {
    const room = cleanRoom(req.headers.get('X-Room') ?? '');
    const open = this.ctx.getWebSockets();
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    if (open.length >= ROOM_LIMIT) {
      server.send(JSON.stringify({ t: 'full' } satisfies ServerMsg));
      server.close(4001, 'Room full');
      return new Response(null, { status: 101, webSocket: client });
    }
    // Ids only need to be unique among the pilots connected now.
    let id = 1;
    for (const ws of open) id = Math.max(id, (this.pilot(ws)?.id ?? 0) + 1);
    server.serializeAttachment({ id, name: 'Pilot', room, ready: false } satisfies Pilot);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) return;
    const now = Date.now();
    let rate = this.rates.get(ws);
    if (!rate || now - rate.at >= 1000) this.rates.set(ws, (rate = { at: now, poses: 0, events: 0, all: 0 }));
    if (++rate.all > FLOOD) {
      ws.close(1008, 'Too many messages');
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const me = this.pilot(ws);
    if (!me) return;
    const t = (msg as { t?: unknown })?.t;

    if (t === 'hi') {
      if (me.ready) return;
      me.name = cleanName((msg as { name?: unknown }).name);
      me.ready = true;
      ws.serializeAttachment(me);
      const peers: PeerInfo[] = [];
      for (const other of this.ctx.getWebSockets()) {
        const p = this.pilot(other);
        if (other !== ws && p?.ready) peers.push({ id: p.id, name: p.name });
      }
      await this.forgetRebuilt();
      const now = Date.now();
      const down = [...this.cmps];
      this.send(ws, { t: 'welcome', id: me.id, peers, parts: [...this.parts], cmps: down.map(([id]) => id), ages: down.map(([, at]) => (now - at) / 1000) });
      this.broadcast(ws, { t: 'join', id: me.id, name: me.name });
      await this.report();
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + LOBBY_REFRESH);
      return;
    }
    if (!me.ready) return;

    if (isPose(msg)) {
      if (++rate.poses > POSE_RATE) return;
      // Rebuilt field by field so nothing extra rides along.
      this.broadcast(ws, { t: 'p', a: msg.a, s: msg.s, r: msg.r, f: msg.f, from: me.id });
    } else if (isEvent(msg)) {
      if (++rate.events > EVENT_RATE) return;
      const e = msg.e;
      if (e.k === 'part') {
        const key = `${e.id}:${e.i}`;
        // Already down, or the whole compound is: nothing new to tell anyone.
        if (this.parts.has(key) || this.isDown(e.id)) return;
        if (this.parts.size < MAX_PARTS) {
          this.parts.add(key);
          await this.ctx.storage.put('parts', [...this.parts]);
        }
      } else if (e.k === 'cmp') {
        if (this.isDown(e.id)) return;
        await this.forgetRebuilt();
        if (this.cmps.size < MAX_CMPS) {
          this.cmps.set(e.id, Date.now());
          // The whole compound is down: its parts no longer need remembering, and when it is
          // rebuilt they start fresh.
          for (const k of this.parts) if (k.startsWith(`${e.id}:`)) this.parts.delete(k);
          await this.ctx.storage.put({ parts: [...this.parts], cmps: [...this.cmps] });
        }
      }
      this.broadcast(ws, { t: 'ev', e, from: me.id });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.leave(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.leave(ws);
  }

  private async leave(ws: WebSocket): Promise<void> {
    this.rates.delete(ws);
    const me = this.pilot(ws);
    if (me?.ready) this.broadcast(ws, { t: 'leave', id: me.id });
    const left = this.ctx.getWebSockets().filter((o) => o !== ws && o.readyState === WebSocket.OPEN);
    if (me?.ready) await this.report(ws, me.room);
    if (left.length === 0) {
      // Last one out: the next flight in this world starts fresh.
      this.parts.clear();
      this.cmps.clear();
      await this.ctx.storage.deleteAll();
    }
  }

  /** Keep the lobby's entry for this room fresh while anyone is here. */
  async alarm(): Promise<void> {
    if (await this.report()) await this.ctx.storage.setAlarm(Date.now() + LOBBY_REFRESH);
  }

  /**
   * Tell the lobby who is in this room (nobody: it drops off the list). `leaving` is a socket
   * on its way out, not counted. Returns how many pilots are here.
   */
  private async report(leaving?: WebSocket, room = ''): Promise<number> {
    const names: string[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const p = this.pilot(ws);
      if (!p || ws === leaving || ws.readyState !== WebSocket.OPEN) continue;
      room ||= p.room;
      if (p.ready) names.push(p.name);
    }
    if (!room) return names.length;
    try {
      await lobbyOf(this.env).report(room, names);
    } catch {
      // The list is a convenience: flying together does not depend on it.
    }
    return names.length;
  }

  /** The compound fell less than WRECK_MEMORY seconds ago. */
  private isDown(id: string): boolean {
    const at = this.cmps.get(id);
    return at !== undefined && Date.now() - at < WRECK_MEMORY * 1000;
  }

  /** Drop compounds that have been rebuilt since they fell. */
  private async forgetRebuilt(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [id, at] of this.cmps) {
      if (now - at >= WRECK_MEMORY * 1000) {
        this.cmps.delete(id);
        changed = true;
      }
    }
    if (changed) await this.ctx.storage.put('cmps', [...this.cmps]);
  }

  private pilot(ws: WebSocket): Pilot | null {
    try {
      return (ws.deserializeAttachment() as Pilot | null) ?? null;
    } catch {
      return null;
    }
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // The socket closed under us; its close handler tidies up.
    }
  }

  private broadcast(from: WebSocket, msg: ServerMsg): void {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === from || !this.pilot(ws)?.ready) continue;
      try {
        ws.send(text);
      } catch {
        // As above.
      }
    }
  }
}

/**
 * The list of occupied rooms, one object for the whole relay. Each entry is the room's last
 * report; a room that stops reporting (it should not, but a crash could) ages out.
 */
export class Lobby extends DurableObject<Env> {
  async report(room: string, names: string[]): Promise<void> {
    room = cleanRoom(room);
    if (!room) return;
    if (names.length) await this.ctx.storage.put(room, { names: names.slice(0, ROOM_LIMIT).map(cleanName), at: Date.now() });
    else await this.ctx.storage.delete(room);
  }

  async list(): Promise<LobbyInfo[]> {
    const now = Date.now();
    const out: LobbyInfo[] = [];
    const stale: string[] = [];
    for (const [room, v] of await this.ctx.storage.list<{ names: string[]; at: number }>({ limit: 1000 })) {
      if (!v || now - v.at > LOBBY_STALE * 1000) stale.push(room);
      else out.push({ room, pilots: v.names.length, names: v.names });
    }
    for (let i = 0; i < stale.length; i += 128) await this.ctx.storage.delete(stale.slice(i, i + 128));
    out.sort((a, b) => b.pilots - a.pilots || a.room.localeCompare(b.room));
    return out.slice(0, LOBBY_MAX);
  }
}
