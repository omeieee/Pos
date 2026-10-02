/**
 * Realtime socket seam (02 §12.2). Features and the realtime client never construct a WebSocket:
 * they ask this factory, so the P10 shells can swap the transport and tests can drive a fake one.
 *
 * Handlers are plain callbacks. `close` carries the close code the server chose (4401 and 4403
 * mean "sign in again"); a connection that never opened reports 1006.
 */
export interface SocketHandlers {
  open(): void;
  /** One text message from the server. Binary data is dropped. */
  message(data: string): void;
  close(code: number): void;
}

export interface SocketHandle {
  send(data: string): void;
  close(code?: number): void;
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketHandle;

const ABNORMAL_CLOSE = 1006;

/** The browser WebSocket. A constructor that throws (a blocked or malformed address) is a close. */
export const createWebSocket: SocketFactory = (url, handlers) => {
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch {
    queueMicrotask(() => handlers.close(ABNORMAL_CLOSE));
    return { send: () => undefined, close: () => undefined };
  }
  socket.addEventListener('open', () => handlers.open());
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') handlers.message(event.data);
  });
  socket.addEventListener('close', (event) => handlers.close(event.code));
  return {
    send: (data) => socket.send(data),
    close: (code) => {
      try {
        // 1000 is the only code a page may send besides 3000-4999.
        if (code === undefined) socket.close();
        else socket.close(code);
      } catch {
        // already closing
      }
    },
  };
};

/**
 * `https://host/base` -> `wss://host/base/v1/ws`. An empty base means the page's own origin
 * (the dev server's proxy).
 */
export function socketUrl(
  apiBaseUrl: string,
  location?: { protocol: string; host: string },
): string {
  const origin =
    apiBaseUrl.replace(/\/+$/, '') || (location ? `${location.protocol}//${location.host}` : '');
  return `${origin.replace(/^http/, 'ws')}/v1/ws`;
}
