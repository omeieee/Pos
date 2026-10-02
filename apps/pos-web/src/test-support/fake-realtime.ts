/** Doubles for the socket and the app lifecycle, so the realtime client runs without a network. */
import type { Lifecycle, LifecycleHandlers } from '../platform/lifecycle.ts';
import type { SocketFactory, SocketHandlers } from '../platform/socket.ts';

export class FakeSocket {
  readonly sent: unknown[] = [];
  closedByClient: number | 'default' | null = null;

  constructor(
    readonly url: string,
    private readonly handlers: SocketHandlers,
  ) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number): void {
    this.closedByClient = code ?? 'default';
  }

  /** What the server does. */
  open(): void {
    this.handlers.open();
  }

  receive(message: unknown): void {
    this.handlers.message(JSON.stringify(message));
  }

  receiveRaw(text: string): void {
    this.handlers.message(text);
  }

  serverClose(code: number): void {
    this.handlers.close(code);
  }
}

export function createFakeSockets() {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = (url, handlers) => {
    const socket = new FakeSocket(url, handlers);
    sockets.push(socket);
    return socket;
  };
  return {
    factory,
    sockets,
    last: (): FakeSocket => {
      const socket = sockets[sockets.length - 1];
      if (!socket) throw new Error('no socket was opened');
      return socket;
    },
  };
}

export function createFakeLifecycle(initial: { online?: boolean; visible?: boolean } = {}) {
  let online = initial.online ?? true;
  let visible = initial.visible ?? true;
  const listeners = new Set<LifecycleHandlers>();
  const lifecycle: Lifecycle = {
    isOnline: () => online,
    isVisible: () => visible,
    subscribe(handlers) {
      listeners.add(handlers);
      return () => void listeners.delete(handlers);
    },
  };
  return {
    lifecycle,
    listenerCount: () => listeners.size,
    goOffline() {
      online = false;
      for (const l of [...listeners]) l.offline?.();
    },
    goOnline() {
      online = true;
      for (const l of [...listeners]) l.online?.();
    },
    show() {
      visible = true;
      for (const l of [...listeners]) l.visible?.();
    },
    hide() {
      visible = false;
    },
  };
}
