---
name: ws-test-quirks
description: Gotchas when testing WebSockets in apps/api (injectWS has no autoPong, needs a socket context, never sees server-side close; use real TCP for close semantics)
metadata:
  type: feedback
---

Realtime tests in `apps/api/src/realtime/` use two clients (helpers in `test-helpers.ts`): `connect` (Fastify `injectWS`, in-memory streams) and `connectTcp` (Node's global `WebSocket` over `app.listen({port:0})`, the browser-like one).

- `injectWS` builds its client without `autoPong`: it never answers protocol pings. The helper sets `_autoPong = true` on the socket in `onInit`; a test that wants a dead client sets it back to false.
- `injectWS(path)` with no `{socket:{remoteAddress}}` context hangs ("websocket upgrade failed" in the log: `request.ip` throws). Always pass a context.
- On in-memory streams the server-side `close` event arrives only after ws's 30 s close timer, so slots (per-IP, total) are not freed. Prove "a closed socket frees its slot" and clean 1001 shutdown over real TCP (`ws-tcp.test.ts`), and give the injectWS harness a high `maxTotal`.
- `@fastify/websocket` must be registered on the ROOT app (`setupRealtime`) for `app.injectWS` to exist, and it upgrades requests to ANY route it covers and logs the URL: the root `onRequest` hook in `realtime/routes.ts` refuses every upgrade except `/v1/ws` (a signed QR link is in a URL).
- The plugin moves a `websocket: true` handler into the closure, so the start-up check cannot see a mark on it: the route is declared with `app.route({wsHandler, handler})` and the mark sits on `wsHandler`.
- `pg_sleep` in PGlite blocks the event loop, so it cannot simulate a slow async check; inject `checkSession` (a hub option) instead.
- A fast heartbeat (tests use 150 ms) must stay generous: under full-suite load a pong can be late and a responsive client gets dropped.

**Why:** each cost real debugging time on 2026-10-02 (P3 task 6).
**How to apply:** any new WebSocket or hub test; copy the helpers, do not rediscover these.

Also: the Bash tool in this worktree refuses compound commands (heredoc plus other commands); write a script file to the scratchpad and run it as one plain command, or use the Edit tool.
