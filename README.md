# 狼人杀助手 · Werewolf Judge Helper

A mobile-first web app that runs a game of 狼人杀 (Werewolf/Mafia) without a
human host: it deals roles, walks each player through their night action in
the correct order, resolves deaths, runs the day vote, and announces the
winner — everything a human "judge" would normally do out loud.

This is a ground-up rewrite of an earlier Flask/jQuery/MongoDB version. The
game rules are the same; the stack, architecture, and UI are new.

## Stack

- **SvelteKit 5** (Svelte 5 runes) + **Tailwind CSS v4** for the UI
- **Socket.IO** for realtime play, attached to the same HTTP server SvelteKit runs on
- **Redis** as the only data store — rooms are short-lived (6h TTL), so there's
  no need for a persistent database. Atomic multi-step operations (taking a
  seat, submitting the room config, advancing a night stage, resolving a
  hunter's shot) are implemented as Lua scripts to stay race-free under
  concurrent players.
- **TypeScript** throughout, with a `src/lib/shared/` layer imported by both
  client and server so the Socket.IO event contract (`ClientAction` /
  `ServerEvent`, validated at runtime with **Zod**) can't drift out of sync.
- **Vitest** for the pure game-logic modules (night resolution, win
  condition, dealing) — the exact rules are easy to get subtly wrong, so
  these are unit-tested directly rather than only through the UI.

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
| `npm test`                        | Run the Vitest suite for `src/lib/shared/**`                                                                  |
| `npm run check`                   | `svelte-kit sync` + `svelte-check` (type checking)                                                            |
| `npm run lint` / `npm run format` | Prettier + ESLint                                                                                             |

## Architecture

```
src/
  lib/
    shared/    # roles, game types, night-resolution/win-condition logic, the
               # Socket.IO event contract - zero server-only deps, safe to
               # import from both client and server code
    server/    # Redis access, room repo + Lua scripts, the game state
               # machine, session handling, Socket.IO server + handlers -
               # never imported from a +page.svelte
    client/    # thin socket.io-client wrapper + the reactive game store
               # ($state-based) that drives the room UI
    components/  # the room/game UI: seat circle, role config, per-role
                 # night-action prompts, vote board, game-over screen, etc.
  routes/
    register/  → lobby/  → room/[code]/   # the whole app is these 3 pages;
                                           # room/[code] renders whichever
                                           # phase the room is currently in
server/index.ts   # production entrypoint: SvelteKit's Node adapter handler
                   # + attachSocketIO(), bundled by esbuild into build-server/
static/audio/      # the judge's voice cues (mp3), reused from the old app
```

**Auth**: an HMAC-signed opaque session cookie references a session record
in Redis — no JWT, and the Socket.IO handshake trusts only that signed
cookie, never anything the client sends in its connection payload.

**Authorization**: host-only actions (submitting the role config, starting
the game, ending a vote) compare the authenticated session against
`hostSessionId` stored server-side — the client never sends an "I'm the
host" flag, so there's nothing to spoof. Similarly, a player's seat is
always resolved server-side from their session, never taken from client
input; night-action submissions are checked against the role actually dealt
to that seat, so a client can't claim to be a role it wasn't dealt.

**Game state machine**: `src/lib/server/game/stateMachine.ts` drives phases
(`LOBBY → SEATING → NIGHT_ACTIONS → [NIGHT_HUNTER_SHOT] → DAY_VOTE →
[DAY_HUNTER_SHOT] → NIGHT_ACTIONS → … → GAME_OVER`) and an ordered list of
night stages, skipping any role with no living seated holder. Only 8 roles
have an implemented night action (普通狼人/预言家/女巫/猎人/守卫/狼美人/丘比特/盗贼);
every other role in the roster is tracked for alive/dead + win-condition
counting only, matching the original app's scope.

## Notes on the game logic

- Night resolution (`src/lib/shared/nightResolution.ts`) is a direct,
  unit-tested port of the original algorithm, including the order-dependent
  "同守同救" quirk (if the guard protects the exact seat the witch also
  saves with her antidote the same night, that seat dies anyway).
- Dealing (`src/lib/shared/deal.ts`) uses a plain uniform shuffle. The
  original app attempted to keep wolf cards out of the 盗贼's buried pile
  but had a bug that meant it never actually worked; that special-casing
  was not reproduced here.
