/* WebSocket transport — the production path, connecting to the Durable Object.
 *
 * Same interface as the local BroadcastChannel transport, so nothing above
 * this file changes between development and production.
 */

import type { ClientMessage, ServerMessage } from './protocol';
import type { RoomTransport } from './transport';

export interface WebSocketTransportOptions {
  /** ws:// or wss:// base of the rooms worker. */
  baseUrl: string;
  roomId: string;
  clientId: string;
  name: string;
  adminKey?: string;
  /** Give up and report the room as gone after this long with no heartbeat. */
  heartbeatTimeoutMs?: number;
}

export class WebSocketTransport implements RoomTransport {
  readonly clientId: string;
  private ws: WebSocket | null = null;
  private messageHandler: ((m: ServerMessage) => void) | null = null;
  private closeHandler: ((reason: string) => void) | null = null;
  private openHandler: (() => void) | null = null;
  private queue: ClientMessage[] = [];
  private closed = false;
  private heartbeatTimer: number | null = null;
  private lastSeen = Date.now();

  constructor(private opts: WebSocketTransportOptions) {
    this.clientId = opts.clientId;
  }

  /** Resolves once the socket is open, rejects if it cannot connect. */
  connect(): Promise<void> {
    const { baseUrl, roomId, clientId, name, adminKey } = this.opts;
    const params = new URLSearchParams({ room: roomId, client: clientId, name });
    if (adminKey) params.set('k', adminKey);

    const url = `${baseUrl.replace(/\/$/, '')}/?${params.toString()}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        settled = true;
        this.lastSeen = Date.now();
        for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
        this.startHeartbeat();
        this.openHandler?.();
        resolve();
      };

      ws.onmessage = (ev) => {
        this.lastSeen = Date.now();
        let parsed: ServerMessage;
        try {
          parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        } catch {
          return;
        }
        if ((parsed as { t?: string })?.t === 'connected') return;
        this.messageHandler?.(parsed);
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('could not reach the room server'));
        }
      };

      ws.onclose = () => {
        this.stopHeartbeat();
        if (!settled) {
          settled = true;
          reject(new Error('the room closed before it connected'));
          return;
        }
        if (!this.closed) {
          this.closed = true;
          this.closeHandler?.('disconnected from the room');
        }
      };
    });
  }

  private startHeartbeat(): void {
    const timeout = this.opts.heartbeatTimeoutMs ?? 20000;
    this.heartbeatTimer = window.setInterval(() => {
      if (Date.now() - this.lastSeen > timeout) {
        this.closed = true;
        this.closeHandler?.('the room stopped responding');
        try { this.ws?.close(); } catch { /* already gone */ }
        return;
      }
      // A ping doubles as keep-alive for intermediaries that drop idle sockets.
      this.raw({ t: 'ping', sentAt: Date.now() });
    }, 10000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private raw(message: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      // Hold anything sent before the socket opens rather than losing it.
      this.queue.push(message);
    }
  }

  send(message: ClientMessage): void { this.raw(message); }
  onMessage(handler: (m: ServerMessage) => void): void { this.messageHandler = handler; }
  onClose(handler: (reason: string) => void): void { this.closeHandler = handler; }
  onOpen(handler: () => void): void { this.openHandler = handler; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    try {
      this.raw({ t: 'bye' });
      this.ws?.close();
    } catch { /* already gone */ }
  }
}