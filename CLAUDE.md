# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A mobile-first web app that runs a game of 狼人杀 (Werewolf/Mafia) without a human host: it deals roles, walks each player through their night action in the correct order, resolves deaths, runs the day vote, and announces the winner. This is a ground-up SvelteKit rewrite of an earlier Flask/jQuery/MongoDB prototype (same rules, new stack/architecture/UI).

**Stack**: SvelteKit 5 (Svelte 5 runes) + Tailwind CSS v4, Socket.IO for realtime play (attached to the same HTTP server SvelteKit runs on), Redis as the _only_ data store (rooms are short-lived, 6h TTL — no persistent DB), TypeScript throughout, Zod for runtime validation of the Socket.IO event contract, Vitest for pure game-logic unit tests.

## Commands

```sh
npm run dev              # dev server (Vite + Socket.IO dev plugin on the same HTTP server)
npm run build            # SvelteKit build + esbuild bundle of server/index.ts -> build-server/index.js
npm start                # run the production build: node build-server/index.js
npm test                 # vitest run (src/lib/shared/**)
npx vitest run path/to/file.spec.ts   # run a single test file
npx vitest run -t "test name"         # run a single test by name
npm run check             # svelte-kit sync + svelte-check (type checking)
npm run check:watch       # same, in watch mode
npm run lint              # prettier --check . && eslint .
npm run format             # prettier --write .
```

Requires Node ≥22 and a local Redis instance (`brew install redis && brew services start redis`). Copy `.env.example` to `.env` and set `SESSION_SECRET` (generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` — the server refuses to start without it).

## Architecture

```
src/
  lib/
    shared/      # roles, game types, night-resolution/win-condition logic, the
                 # Socket.IO event contract (ClientAction/ServerEvent, Zod-validated) -
                 # zero server-only deps, safe to import from both client and server
    server/      # Redis access, room repo + Lua scripts, the game state machine,
                 # session handling, Socket.IO server + handlers - never imported
                 # from a +page.svelte
    client/      # thin socket.io-client wrapper + the reactive game store
                 # ($state-based, gameStore.svelte.ts) that drives the room UI
    components/  # room/game UI: seat circle, role config, per-role night-action
                 # prompts, vote board, game-over screen, etc.
  routes/
    register/  -> lobby/  -> room/[code]/   # the whole app is these 3 pages; room/[code]
                                             # renders whichever phase the room is in
server/index.ts   # production entrypoint: SvelteKit's Node adapter handler +
                  # attachSocketIO(), bundled by esbuild into build-server/
static/audio/     # the judge's voice cues (mp3), reused from the old app
```

The `shared` / `server` / `client` split under `src/lib/` is load-bearing: `shared` is imported by both sides so the socket event contract can't drift out of sync, `server` code must never leak into a `.svelte` file, and `client` is the only layer that touches `socket.io-client`.

**Socket.IO event flow**: every client action is a discriminated-union `ClientAction` (see `src/lib/shared/events.ts`), Zod-validated, routed through `src/lib/server/socket/dispatch.ts`'s switch statement to a handler under `src/lib/server/socket/handlers/`. Handlers throw `ActionError` for expected/user-facing failures (caught in `dispatchAction` and turned into an `{ ok: false, error }` ack); anything else propagates. Handlers never trust client-supplied identity — see Auth/Authorization below.

**Redis + Lua**: Redis is the only data store. Atomic multi-step operations (taking a seat, submitting the room config, advancing a night stage, resolving a hunter's shot) are implemented as Lua scripts (`src/lib/server/rooms/lua/scripts.ts`) run through `roomRepo.ts`, to stay race-free under concurrent players without needing a transactional DB.

**Auth**: an HMAC-signed opaque session cookie references a session record in Redis — no JWT. The Socket.IO handshake trusts only that signed cookie, never anything the client sends in its connection payload (`src/lib/server/socket/authMiddleware.ts`, `src/lib/server/session.ts`).

**Authorization**: host-only actions (submitting the role config, starting the game, ending a vote) compare the authenticated session against `hostSessionId` stored server-side — the client never sends an "I'm the host" flag. A player's seat is always resolved server-side from their session, never taken from client input; night-action submissions are checked against the role actually dealt to that seat, so a client can't claim a role it wasn't dealt.

**Game state machine** (`src/lib/server/game/stateMachine.ts`): drives phases `LOBBY → SEATING → NIGHT_ACTIONS → [NIGHT_HUNTER_SHOT] → DAY_VOTE → [DAY_HUNTER_SHOT] → NIGHT_ACTIONS → … → GAME_OVER`, and an ordered list of night stages, skipping any role with no living seated holder. Only 8 roles have an implemented night action (普通狼人/预言家/女巫/猎人/守卫/狼美人/丘比特/盗贼); every other role in the roster is tracked for alive/dead + win-condition counting only, matching the original app's scope.

## Game logic notes

- Night resolution (`src/lib/shared/nightResolution.ts`) is a direct, unit-tested port of the original algorithm, including the order-dependent "同守同救" quirk: if the guard protects the exact seat the witch also saves with her antidote the same night, that seat dies anyway.
- Dealing (`src/lib/shared/deal.ts`) uses a plain uniform shuffle. The original app attempted to keep wolf cards out of the 盗贼's buried pile but had a bug that meant it never actually worked; that special-casing was intentionally not reproduced here.
- The exact rules for night resolution / win condition / dealing are easy to get subtly wrong — that's why they're unit-tested directly (`*.spec.ts` next to the modules in `src/lib/shared/`) rather than only exercised through the UI.

## Deployment

Two build artifacts, produced together by `npm run build`: SvelteKit's `adapter-node` output (`build/`) and an esbuild bundle of the standalone Socket.IO server entrypoint (`build-server/index.js`, from `server/index.ts`) that wraps a bare Node HTTP server around SvelteKit's request handler and attaches Socket.IO to it.

This needs a persistent Node process holding long-lived WebSocket connections plus a reachable Redis instance — this rules out serverless/edge platforms (Vercel Edge Functions, Cloudflare Workers without Durable Objects) without a rearchitecture. Render or Railway are the easiest fit (persistent Node web service, full WebSocket support, managed Redis add-on). Env vars: `SESSION_SECRET` (required), `REDIS_URL` (optional, defaults to `redis://127.0.0.1:6379`; `rediss://` for TLS), `PORT` (optional, defaults to 3000), `NODE_ENV=production` (recommended, issues the session cookie with `secure`).

Not yet set up: response security headers (CSP, `X-Frame-Options`, etc.) — `src/hooks.server.ts` currently sets none.
