import type { ClientMsg, ServerMsg } from './protocol';

export type NetStatus = 'connecting' | 'online' | 'offline' | 'full';

/** A message from the relay, or `lost` when the connection drops (everyone else is gone until it comes back). */
export type NetMessage = ServerMsg | { t: 'lost' };

export interface Incoming {
  /** Local receive time, seconds (performance clock). */
  at: number;
  msg: NetMessage;
}

/**
 * One WebSocket to the relay's room. It reconnects on its own with a growing
 * delay. Messages are queued as they arrive and drained once a frame, so all
 * game state changes happen inside the frame loop.
 */
export class NetClient {
  status: NetStatus = 'connecting';
  /** Our id in the room, once welcomed. */
  id = 0;
  private ws: WebSocket | null = null;
  private inbox: Incoming[] = [];
  private retry = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(readonly url: string, readonly room: string, private name: string) {
    this.open();
  }

  private open(): void {
    this.status = 'connecting';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${this.url.replace(/\/$/, '')}/room/${encodeURIComponent(this.room)}`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hi', name: this.name } satisfies ClientMsg));
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        this.status = 'online';
        this.id = msg.id;
        this.retry = 1;
      } else if (msg.t === 'full') {
        this.status = 'full';
        this.closed = true;
      }
      // A hidden tab stops drawing frames but keeps receiving: drop poses rather than pile them up.
      // Events (wrecks) are always kept.
      if (msg.t === 'p' && this.inbox.length > 400) return;
      this.inbox.push({ at: performance.now() / 1000, msg });
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const wasOnline = this.status === 'online';
      if (wasOnline) this.inbox.push({ at: performance.now() / 1000, msg: { t: 'lost' } });
      if (this.closed) {
        if (this.status !== 'full') this.status = 'offline';
        return;
      }
      this.scheduleRetry();
    };
    // A failed connection also closes; the close handler retries.
    ws.onerror = () => {};
  }

  private scheduleRetry(): void {
    this.status = 'connecting';
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closed) this.open();
    }, this.retry * 1000);
    this.retry = Math.min(15, this.retry * 2);
  }

  /** Send if connected; dropped otherwise (poses are replaced by the next one anyway). */
  send(msg: ClientMsg): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.status !== 'online') return;
    // On a slow link, skip rather than queue stale poses.
    if (msg.t === 'p' && ws.bufferedAmount > 32768) return;
    ws.send(JSON.stringify(msg));
  }

  /** Everything received since the last call. */
  take(): Incoming[] {
    const out = this.inbox;
    this.inbox = [];
    return out;
  }

  close(): void {
    this.closed = true;
    this.status = 'offline';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'Bye');
  }
}
