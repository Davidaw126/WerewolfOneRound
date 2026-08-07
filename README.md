# 狼人杀助手 · Werewolf Judge Helper

A mobile-first web app that runs a full game of 狼人杀 (Werewolf/Mafia)
without a human host: it deals all 15 spec roles, walks each player through
their night action in the correct order, resolves deaths, runs the full day
phase (last words, discussion, vote, PK re-vote on ties), and announces the
winner — everything a human "judge" would normally do out loud.

This is a ground-up rewrite of an earlier Flask/jQuery/MongoDB version,
itself later rebuilt again around a pure functional game engine (see
Architecture below) — same rules, several stacks since.

## Stack

- **SvelteKit 5** (Svelte 5 runes) + **Tailwind CSS v4** for the UI
- **Socket.IO** for realtime play, attached to the same HTTP server SvelteKit runs on
- **Redis** as the only data store — rooms are short-lived (6h TTL), so there's
  no need for a persistent database. Atomic multi-step operations (taking a
  seat, submitting the room config) are implemented as Lua scripts to stay
  race-free under concurrent players; `@socket.io/redis-adapter` is already
  wired up, so the socket layer itself can run as multiple horizontally
  scaled instances behind a load balancer without breaking cross-instance
  broadcast.
- **TypeScript** throughout. A pure `src/lib/game/` engine (no Svelte/
  Socket.IO/Redis imports, using **immer** for copy-on-write state updates)
  is the source of truth for game rules; `src/lib/shared/` is the Socket.IO
  event contract (`ClientAction`/`ServerEvent`, validated at runtime with
  **Zod**) imported by both client and server so it can't drift out of sync.
- **Vitest** for the pure game engine (night resolution, win condition,
  dealing, every role's edge cases) — the exact rules are easy to get subtly
  wrong, so these are unit-tested directly rather than only through the UI.

## Getting started

Requires Node.js ≥22 and a local Redis instance.

```sh
brew install redis && brew services start redis   # if you don't have Redis yet
cp .env.example .env                                # then fill in SESSION_SECRET
npm install
npm run dev
```

`SESSION_SECRET` signs the session cookie — generate one with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Open the printed local URL, register with a name, and either create a room
or join one with a 6-digit code from another browser tab/device.

## Scripts

| Command                           | Purpose                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                     | Dev server (Vite + a Socket.IO dev plugin attached to the same HTTP server)                                   |
| `npm run build`                   | Production build: SvelteKit's own build, plus an esbuild bundle of the standalone Socket.IO server entrypoint |
| `npm start`                       | Run the production build (`node build-server/index.js`)                                                       |
| `npm test`                        | Run the Vitest suite (mostly `src/lib/game/**`)                                                               |
| `npm run check`                   | `svelte-kit sync` + `svelte-check` (type checking)                                                            |
| `npm run lint` / `npm run format` | Prettier + ESLint                                                                                             |

## Deployment

The production build is two artifacts: SvelteKit's own `adapter-node` output
(`build/`) and an esbuild bundle of the standalone Socket.IO server
entrypoint (`build-server/index.js`, see `server/index.ts`) that wraps a bare
Node HTTP server around SvelteKit's request handler and attaches Socket.IO to
it. `npm run build` produces both, in the right order.

```sh
npm run build
npm start          # node build-server/index.js
```

Required environment variables (see `.env.example`):

| Variable         | Required    | Notes                                                                                                                                                                   |
| ---------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_SECRET` | Yes         | HMAC key for signing session cookies. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. The server refuses to start without it. |
| `REDIS_URL`      | No          | Defaults to `redis://127.0.0.1:6379` if unset - set this to your production Redis instance. `rediss://` enables TLS (e.g. for Upstash/Redis Cloud).                     |
| `PORT`           | No          | Defaults to `3000`.                                                                                                                                                     |
| `NODE_ENV`       | Recommended | Set to `production` so the session cookie is issued with the `secure` flag.                                                                                             |

Node ≥22 is required (`engines` in `package.json`, enforced at install time
via `.npmrc`'s `engine-strict`).

**Choosing a host**: this app needs a persistent Node process holding
long-lived WebSocket connections (Socket.IO) plus a reachable Redis instance
— that rules out serverless/edge platforms (Vercel Edge Functions, Cloudflare
Workers without Durable Objects) without a rearchitecture. **Render** or
**Railway** are the easiest fit: both run a persistent Node web service with
full WebSocket support and a managed Redis add-on, deploying straight from
`package.json`'s scripts with no Dockerfile needed. A plain VPS (DigitalOcean/
Hetzner droplet) is the cheaper always-on alternative if you'd rather avoid
platform lock-in, at the cost of managing Node/Redis/a process manager/TLS
yourself.

Response security headers (CSP, `X-Frame-Options`, `X-Content-Type-Options`,
`Referrer-Policy`, `Permissions-Policy`, HSTS in production) are set in
`src/hooks.server.ts`/`vite.config.ts`'s `csp` option. `GET /health` returns
`{ ok: true }` (200) if Redis is reachable, `{ ok: false }` (503) otherwise —
point your platform's readiness/liveness probe at it. `server/index.ts`
handles `SIGTERM`/`SIGINT` by draining connections before exiting, so a
redeploy doesn't hard-kill live games.

## Architecture

```
src/
  lib/
    game/      # the pure game engine - zero imports from Svelte/Socket.IO/
               # Redis, safe to unit-test in isolation. engine.ts's
               # reduce(state, action) is the sole source of truth for rules
    shared/    # the wire contract only: ClientAction/ServerEvent (Zod-
               # validated), plus the legacy role/art lookups still used to
               # deal and render - zero server-only deps
    server/    # everything IO-bound: Redis access, room repo + Lua scripts,
               # the IO shell around the engine (loads/reduces/saves under a
               # per-room lock), session handling, Socket.IO handlers -
               # never imported from a +page.svelte
    client/    # thin socket.io-client wrapper + the reactive game store
               # ($state-based) that drives the room UI
    components/  # the room/game UI: seat circle, role config, per-role
                 # night-action prompts, day-phase panels, vote board,
                 # game-over screen, host override panel, etc.
  routes/
    register/  → lobby/  → room/[code]/   # the whole app is these 3 pages;
                                           # room/[code] renders whichever
                                           # phase the room is currently in
    health/    # GET /health - liveness/readiness probe (checks Redis)
server/index.ts   # production entrypoint: SvelteKit's Node adapter handler
                   # + attachSocketIO(), bundled by esbuild into build-server/
static/audio/      # the judge's voice cues (mp3), reused from the old app
```

Full architecture detail (the exact module layout, phase flow, and secrecy
model) lives in `CLAUDE.md` at the repo root — that's the source of truth
for anyone (human or AI) working in this codebase; keep it in sync with
structural changes rather than duplicating it here.

**Auth**: an HMAC-signed opaque session cookie references a session record
in Redis — no JWT, and the Socket.IO handshake trusts only that signed
cookie, never anything the client sends in its connection payload.

**Authorization**: host-only actions (submitting the role config, starting
the game, advancing day-phase queues, ending a vote, host overrides) compare
the authenticated session against `hostSessionId` stored server-side — the
client never sends an "I'm the host" flag, so there's nothing to spoof.
Similarly, a player's seat is always resolved server-side from their
session, never taken from client input; night-action submissions are
checked against the role actually dealt to that seat.

**Note**: there's currently no host-transfer mechanism — if the host's
session is lost mid-game (not a reconnect, but the device/cookie truly
gone), the room can't be recovered by anyone else. Fine for a supervised
in-person game where the host's phone stays on; worth scoping before
supporting less-supervised play.

## Notes on the game logic

- Night resolution (`src/lib/game/rules/nightResolution.ts`) includes the
  order-dependent "同守同救" quirk (if the guard protects the exact seat the
  witch also saves with her antidote the same night, that seat dies
  anyway), 摄梦人's two-nights-running death, and 野孩子's idol-death
  conversion.
- All 15 spec roles are implemented, with their trickier interactions
  (witch self-save variants, hunter shoot-when-poisoned, knight duel,
  wolf-king explode+shot, etc.) covered directly by `*.spec.ts` files next
  to the modules they test, rather than only exercised through the UI.
