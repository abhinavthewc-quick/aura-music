import type { ClientMessage, ServerMessage } from './protocol';

/**
 * How a client reaches the room referee.
 *
 * The sync engine and UI know nothing about the wire. Local development uses
 * BroadcastChannel (same machine, multiple tabs); production will use a
 * WebSocket to a Durable Object. Swapping between them is one object literal.
 */
export interface RoomTransport {
  send(message: ClientMessage): void;
  onMessage(handler: (message: ServerMessage) => void): void;
  /** Fired when the link drops for any reason. */
  onClose(handler: (reason: string) => void): void;
  close(): void;
}