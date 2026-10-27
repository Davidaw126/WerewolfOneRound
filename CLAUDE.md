# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A mobile-first web app that runs a full game of 狼人杀 (Werewolf/Mafia) without a human host: it deals roles, walks each player through their night action in the correct order, resolves deaths, runs the day phase (last words, discussion, vote, PK re-vote on ties), and announces the winner. All 15 spec roles are implemented. This is a from-scratch SvelteKit rewrite of an earlier Flask/jQuery/MongoDB prototype, itself rebuilt again mid-lifetime around a pure functional game engine (see Architecture) — same rules, several stacks.

**Stack**: SvelteKit 5 (Svelte 5 runes) + Tailwind CSS v4, Socket.IO for realtime play (attached to the same HTTP server SvelteKit runs on), Redis as the _only_ data store (rooms are short-lived, 6h TTL — no persistent DB), TypeScript throughout, Zod for runtime validation of the Socket.IO event contract, Vitest for pure game-logic unit tests, immer for the engine's copy-on-write state updates.

## Commands

```sh
npm run dev              # dev server (Vite + Socket.IO dev plugin on the same HTTP server)
npm run build            # SvelteKit build + esbuild bundle of server/index.ts -> build-server/index.js
npm start                # run the production build: node build-server/index.js
npm test                 # vitest run (all of src/**/*.spec.ts, mostly src/lib/game/**)
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
    game/        # the pure game engine (§2.1.2-style reducer) - zero imports from
                 # Svelte/Socket.IO/Redis, safe to unit-test in isolation
      types.ts       # RoleId/Phase/GameState/RuleConfig/EngineAction/EngineEffect
      roleMeta.ts    # per-role static data (camp, night order, isGod, implemented, ...)
      engine.ts      # reduce(state, action) -> {state, effects[]} + startGame(params)
      roleBridge.ts  # RoleId (engine, 15 roles) <-> legacy Chinese-string Role (wire, 23 names)
      rules/         # deal, nightOrder, nightResolution, nightRules, winCondition,
                     # turnContext, setup (validateSetup/E01-E10), presets
    shared/      # the wire contract only: ClientAction/ServerEvent (events.ts, Zod-
                 # validated), RoomPublicState/Phase/NightStage (gameTypes.ts), the
                 # legacy Role enum + role art/flavor lookups (roles.ts, roleSprites.ts,
                 # etc.) - zero server-only deps, safe to import from both client and
                 # server. deal.ts here is the legacy-Role-keyed shuffle still used to
                 # physically deal a submitted roleConfig (see Dealing below) - not to
                 # be confused with game/rules/deal.ts's RoleId-keyed buried-card logic.
    server/      # everything IO-bound - never imported from a +page.svelte
      game/          # the IO shell around the pure engine:
                     #   gameStateRepo.ts   - load/reduce/save under a per-room Redis
                     #                        lock, plus the action log (room:{code}:actions)
                     #   gameSync.ts        - broadcasts PhaseChanged on real transitions,
                     #                        schedules 假环节/auto-advance timers
                     #   effectTranslator.ts - EngineEffect[] -> actual socket emits,
                     #                        RoleId -> legacy Role translation
                     #   projection.ts      - GameState -> RoomPublicState/legacy-Phase
                     #                        projections (also the S4 role-redaction point)
      rooms/         # Redis access, room repo, Lua scripts for the pre-game atomics
                     # (taking a seat, submitting the room config)
      socket/        # dispatch.ts's switch -> handlers/*.ts, session/auth middleware,
                     # rate limiting
    client/      # thin socket.io-client wrapper + the reactive game store
                 # ($state-based, gameStore.svelte.ts) that drives the room UI
    components/  # room/game UI: seat circle, role config, per-role night-action
                 # prompts, day-phase panels, vote board, game-over screen, etc.
  routes/
    register/  -> lobby/  -> room/[code]/   # the whole app is these 3 pages; room/[code]
                                             # renders whichever phase the room is in
server/index.ts   # production entrypoint: SvelteKit's Node adapter handler +
                  # attachSocketIO(), bundled by esbuild into build-server/
static/audio/     # the judge's voice cues (mp3), reused from the old app
```

The `game` / `shared` / `server` / `client` split is load-bearing: `game` never imports anything IO-related, so its `reduce()` is pure and directly unit-testable; `shared` is imported by both client and server so the socket event contract can't drift out of sync; `server` code must never leak into a `.svelte` file; `client` is the only layer that touches `socket.io-client`. `shared` and `game` each have their own `Role`-ish type — `shared`'s `Role` is the wire-facing legacy Chinese-string enum (23 names, some with no engine counterpart), `game`'s `RoleId` is the engine's own 15-value enum (§4.1's v1.0 roster) — `roleBridge.ts` is the only place that converts between them.

**The engine is the source of truth for game rules.** `engine.ts`'s `reduce(state, action)` takes an `EngineAction` (`SUBMIT_NIGHT_ACTION`, `ADVANCE_STAGE`, `CAST_VOTE`, `TALLY_VOTES`, `NEXT_SPEAKER`, `BEGIN_VOTE`, `HUNTER_SHOOT`, `SELF_EXPLODE`, `KNIGHT_DUEL`, `HOST_OVERRIDE`, ...) and returns a new `GameState` plus a list of `EngineEffect`s (`BROADCAST`/`PRIVATE`/`NARRATE` — descriptions of what to tell whom, never actual socket calls). It never reads the clock or generates its own randomness — both arrive via the action or `startGame()`'s params, so the same `(state, action)` pair always produces the same result (a room's `room:{code}:actions` log is a complete, replayable history of every action that ever ran). `gameStateRepo.ts`'s `applyGameAction()` is the only place that actually calls `reduce()`, always under `withGameLock` (a `SET NX PX 3000` Redis lock) so two players' actions for the same room can never race each other.

**Phase flow**: `LOBBY → SEATING → FIRST_NIGHT → [NIGHT stages...] → DAWN → [LAST_WORDS] → [HUNTER_SHOOT] → DISCUSSION → VOTE → [VOTE_PK] → [LAST_WORDS] → [HUNTER_SHOOT] → NIGHT → … → GAME_OVER`. `SHERIFF_ELECTION` and a distinct `EXILE` phase exist in the `Phase` type (§7.1 parity) but aren't wired up yet — a day-vote's outcome is announced directly via the `DayResolved` broadcast instead of a separate EXILE phase, and there's no sheriff mechanic (election, vote weight, badge transfer) at all yet. `DAWN` is a real gating phase, not automatic: the night's deaths are computed and applied immediately but withheld from every broadcast until the host taps "公布夜晚结果" (`ANNOUNCE_NIGHT_RESULTS`) — a deliberate deviation from the spec's automatic-on-DAWN announcement. Within a night, `nightOrder.ts` builds the stage order from `ROLE_META[id].nightOrder` for every role that's both `implemented` and either present on the board or in `ALWAYS_ANNOUNCED_ROLES` (WEREWOLF/GUARD/WITCH/SEER/HUNTER always get a stage, live holder or not — 假环节, so the stage _sequence_ itself never leaks who's alive).

**Socket.IO event flow**: every client action is a discriminated-union `ClientAction` (see `src/lib/shared/events.ts`), Zod-validated, routed through `src/lib/server/socket/dispatch.ts`'s switch statement to a handler under `src/lib/server/socket/handlers/`. Handlers throw `ActionError` for expected/user-facing failures (caught in `dispatchAction` and turned into an `{ ok: false, error }` ack); anything else propagates. Handlers never trust client-supplied identity — see Auth/Authorization below.

**Redis**: the only data store. Pre-game atomics (taking a seat, submitting the room config) are Lua scripts (`src/lib/server/rooms/lua/scripts.ts`) run through `roomRepo.ts`. Once a game starts, the entire `GameState` is one JSON blob (`gameStateRepo.ts`), read-modify-written under the per-room lock described above instead of per-field Lua ops.

**Auth**: an HMAC-signed opaque session cookie references a session record in Redis — no JWT. The Socket.IO handshake trusts only that signed cookie, never anything the client sends in its connection payload (`src/lib/server/socket/authMiddleware.ts`, `src/lib/server/session.ts`).

**Authorization**: host-only actions (submitting the role config, starting the game, advancing day-phase queues, ending a vote, 上帝之手 overrides) compare the authenticated session against `hostSessionId` stored server-side — the client never sends an "I'm the host" flag. A player's seat is always resolved server-side from their session, never taken from client input; night-action submissions are checked against the role actually dealt to that seat, so a client can't claim a role it wasn't dealt.

**Secrecy**: `projection.ts` is where a `NightStage`/`GameState` gets redacted into what actually goes out. The room-wide broadcast never says which role is acting (`PublicNightStage` has no `role` field) — only the host gets the real stage, via a private `HostStageChanged` channel, so `JudgeAudioPlayer.svelte`'s narration still knows what to say. Live vote tallies are never broadcast, only who has voted (`votedSeats`); the full breakdown only reaches clients via `DayResolved`, after the vote already closed. A room locks against new (non-returning) joins once seats are locked or the game has started.

**Dealing**: `shared/deal.ts`'s `dealCards()`/`deriveSeatCount()` shuffles the submitted (legacy-Role-keyed) `roleConfig` into seats — the last 2 cards go to the 盗贼's buried pile if THIEF is in play. The result is bridged through `roleBridge.ts` into `RoleId`-keyed identities before `startGame()` ever sees it.

## Game logic notes

- Night resolution (`src/lib/game/rules/nightResolution.ts`) is a unit-tested port of the original algorithm, including the order-dependent "同守同救" quirk (guard-protects-same-seat-witch-saves still dies), 摄梦人's two-nights-running death, and 野孩子's idol-death conversion (which recounts the win condition immediately, since a converted seat's camp changes for both purposes on the spot).
- All 15 spec roles are implemented (`ROLE_META[id].implemented`, `roleMeta.ts`) — the 8 original P0 roles, IDIOT/KNIGHT/WOLF_KING (reveal-on-exile, duel, self-explode+shot), and WILD_CHILD/DREAM_WEAVER/NIGHTMARE. 盗贼 is forced to take a wolf card if both buried cards are wolf-team roles (`thief.mustTakeWolfIfBothWolf`).
- The exact rules for night resolution / win condition / dealing / day-phase transitions are easy to get subtly wrong — that's why they're unit-tested directly (`*.spec.ts` next to the modules in `src/lib/game/`, plus `engine.spec.ts` for full-flow integration) rather than only exercised through the UI.
- `RuleConfig` (`game/types.ts`, defaults in `game/defaultRuleConfig.ts`) is the ~60-switch, spec-§6-shaped rule set snapshotted per game; the host only ever configures a small overridable subset (`RuleConfigOverridesSchema` in `shared/events.ts`).

## Deployment

Two build artifacts, produced together by `npm run build`: SvelteKit's `adapter-node` output (`build/`) and an esbuild bundle of the standalone Socket.IO server entrypoint (`build-server/index.js`, from `server/index.ts`) that wraps a bare Node HTTP server around SvelteKit's request handler and attaches Socket.IO to it.

This needs a persistent Node process holding long-lived WebSocket connections plus a reachable Redis instance — this rules out serverless/edge platforms (Vercel Edge Functions, Cloudflare Workers without Durable Objects) without a rearchitecture. Render or Railway are the easiest fit (persistent Node web service, full WebSocket support, managed Redis add-on). Env vars: `SESSION_SECRET` (required), `REDIS_URL` (optional, defaults to `redis://127.0.0.1:6379`; `rediss://` for TLS), `PORT` (optional, defaults to 3000), `NODE_ENV=production` (recommended, issues the session cookie with `secure`).

Response security headers (CSP via SvelteKit's own `csp` Vite-plugin option, plus `X-Frame-Options`/`X-Content-Type-Options`/`Referrer-Policy`/`Permissions-Policy`/HSTS) are set in `src/hooks.server.ts`.

## Working rules (from the maintainer)

- **Push and deploy only when explicitly asked.** Commit locally as you go; Render auto-deploys on every push to `master`. Live URL: https://werewolf-judge-helper.onrender.com (`/health` returns 200). To confirm a deploy, fetch `/` with `curl -L` (it redirects to `/register`), trace → `_app/immutable/entry/app.*.js` → `nodes/*` → `chunks/*` and grep for a string from the change — `/room/XXXX` has no app entry to trace from.
- **Don't change the Render config** (`render.yaml`, env vars, headers like `ADDRESS_HEADER`) without asking first.
- **Keep the legacy vote / `HUNTER_SHOOT` code** (unreachable while `shotsAtTable=false`). Report it as dead code; don't delete it.
- **In-game reads come from `GameState`, never the seating-time Redis keys** (`identities`, `deadSeats`, …) — those drift once roles change in play (上帝之手 SET_ROLE, 盗贼, 野孩子). Use `roomRepo.currentRoleOfSeat()`. `rooms/roomRepo.ts` is the Room module: it alone touches the room's Redis keys and decides which store answers "who sits in seat N / what role is it" (handlers, `effectTranslator`, `gameSync` call it). Its tests (`roomRepo.spec.ts`) run against local Redis database 15.
- **Secrecy invariants**: deaths stay out of every projection until 公布 (`deadSeatsOf` excludes `pendingNightDeaths`); 上帝之手 改变身份 goes only to the host and that player; the host's real stage (`hostStage`) only to the host; a dead role's turn still runs as a 假环节 with realistic timing (`fakeStageDurationMs` in `gameSync.ts`).
- **Before calling a change done**: `npm test`, `npm run check`, `npm run lint`. For server/socket changes also run the real-server e2e: start Redis and `npm run dev -- --port 5173 --strictPort`, then `npm run e2e` (both games), `npm run e2e -- basic` or `npm run e2e -- special` (丘比特/盗贼/守卫/猎人). `-- halt` then restart the server then `-- resume` checks that night timers survive a restart. If registration hits the rate limit locally: `redis-cli del 'wolf:ratelimit:register:::1'`.
- **Prove bugs before fixing**: write the test first and check it fails on the old code.
- The user plays on iPhones: no Web Audio alongside `speechSynthesis` (it breaks the voice on iOS — see `client/sfx.ts`); check layouts at phone width.
