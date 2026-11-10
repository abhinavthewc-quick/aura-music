/* Local-only socket fixture for visual room states. It never opens a socket. */
export function installRoomFixture(fixture) {
  const room = fixture.room = {
    sent: [], socket: null, you: null, participants: [], queue: [],
    playback: { trackKey: null, videoId: null, positionMs: 0, playing: false, updatedAt: 0, startAt: null, rev: 0 },
    receive(message) { this.socket?.receive(message); },
    setRole(role) {
      this.you = { ...this.you, role };
      this.participants = [this.you, { id: 'peer', name: 'Evening listener', role: 'listener', joinedAt: Date.now() }];
      this.receive({ t: 'participants', participants: this.participants, serverTime: Date.now() });
    },
    setPlayback(fields) {
      this.playback = { ...this.playback, ...fields, rev: this.playback.rev + 1 };
      this.receive({ t: 'playback', playback: this.playback, serverTime: Date.now() });
    },
    setQueue(queue) {
      this.queue = queue;
      this.receive({ t: 'queue', queue, serverTime: Date.now() });
    },
  };
  window.WebSocket = class extends EventTarget {
    static OPEN = 1;
    constructor(url) {
      super();
      if (new URL(url).hostname !== 'fixture.invalid') throw new Error('Fixture blocked a real room socket');
      room.socket = this;
      this.readyState = 0;
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event('open')); });
    }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
    send(raw) {
      const message = JSON.parse(raw);
      room.sent.push(message);
      if (message.t === 'hello') {
        room.you = { id: message.clientId, name: message.name, role: message.adminKey ? 'admin' : 'listener', joinedAt: Date.now() };
        room.participants = [room.you, { id: 'peer', name: 'Evening listener', role: 'listener', joinedAt: Date.now() }];
        queueMicrotask(() => this.receive({ t: 'welcome', you: room.you, snapshot: { roomId: 'fixture', playback: room.playback, queue: room.queue, participants: room.participants, expiresAt: Date.now() + 3600000 }, serverTime: Date.now() }));
      } else if (message.t === 'ping') {
        queueMicrotask(() => this.receive({ t: 'pong', sentAt: message.sentAt, serverTime: Date.now() }));
      } else if (message.t === 'chat') {
        queueMicrotask(() => this.receive({ t: 'chat', message: { id: 'fixture-chat', name: room.you.name, text: message.text, at: Date.now() } }));
      }
    }
    close() { this.readyState = 3; this.onclose?.(new Event('close')); }
  };
  const previousFetch = window.fetch;
  window.fetch = (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.pathname !== '/api/rooms') return previousFetch(input, init);
    const body = JSON.parse(init.body || '{}');
    fixture.requests.push({ method: init.method || 'GET', path: url.pathname, action: body.action });
    return Promise.resolve(Response.json(body.action === 'create'
      ? { roomId: 'fixture', adminKey: 'fixture:not-a-real-key' }
      : { exists: true, wsBase: 'wss://fixture.invalid' }));
  };
}
