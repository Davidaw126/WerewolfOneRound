// M1's persistence + concurrency layer for the new pure engine (§12.3/§2.1.5):
// the engine itself never touches Redis - this module is the only place that
// loads a GameState, runs it through `reduce`, and saves the result, always
// under a per-room lock so two players' actions arriving in the same tick
// can never both read-modify-write the same state and silently clobber one
// another (the concern the old app solved narrowly, per-field, with
// stageEpoch/CAS Lua scripts - a single lock around the whole cycle replaces
// all of that at once).

import { randomUUID } from 'node:crypto';
import { redis } from '../redis';
import { ROOM_TTL_SECONDS, gameStateKey, gameLockKey, roomKey } from '../rooms/keys';
import { reduce, startGame, type StartGameParams } from '../../game/engine';
import type { EngineAction, EngineResult, GameState } from '../../game/types';
import { ActionError } from '../socket/actionError';
import type { Refusal } from '../../shared/events';

export type { Refusal };

const LOCK_TTL_MS = 3000;
const ACQUIRE_RETRY_DELAY_MS = 50;
// ~2s of total retry budget - comfortably longer than any single action
// handler should ever take, so genuine contention (two actions arriving in
// the same tick) always resolves well before this gives up.
const ACQUIRE_MAX_ATTEMPTS = 40;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Only deletes the lock if it still holds THIS call's token - without that
// check, a call that overran LOCK_TTL_MS could delete a lock a completely
// different, later call has since legitimately acquired.
const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
	return redis.call('DEL', KEYS[1])
else
	return 0
end
`;

/** The per-room lock. Every game write runs under it, and so do the Room
 * module's Host-only operations, so a Host check and the change it guards
 * happen as one step. Not reentrant. */
export async function withRoomLock<T>(code: string, fn: () => Promise<T>): Promise<T> {
	const token = randomUUID();
	const key = gameLockKey(code);

	let acquired = false;
	for (let attempt = 0; attempt < ACQUIRE_MAX_ATTEMPTS; attempt++) {
		const res = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX');
		if (res === 'OK') {
			acquired = true;
			break;
		}
		await sleep(ACQUIRE_RETRY_DELAY_MS);
	}
	if (!acquired) throw new ActionError('room_busy');

	try {
		return await fn();
	} finally {
		await redis.eval(RELEASE_LOCK_LUA, 1, key, token);
	}
}

export async function loadGameState(code: string): Promise<GameState | null> {
	const raw = await redis.get(gameStateKey(code));
	return raw ? (JSON.parse(raw) as GameState) : null;
}

/** Saves the game and, in the same step, mirrors its phase into the room.
 * Mirroring any later left a gap where the room still said SEATING with a
 * game running: a second Start or a Re-deal got through it, and a late mirror
 * could put a just-stopped room back into a phase with no game. */
async function saveGameState(code: string, state: GameState): Promise<void> {
	await redis
		.multi()
		.set(gameStateKey(code), JSON.stringify(state), 'EX', ROOM_TTL_SECONDS)
		.hset(roomKey(code), { phase: state.phase, nightNumber: String(state.round) })
		.exec();
}

export async function deleteGameState(code: string): Promise<void> {
	await redis.del(gameStateKey(code));
}

/** Deals the opening GameState (via the engine's own `startGame`) and
 * persists it - the one-time counterpart of `applyGameAction`. `prepare`
 * runs under the room lock first: it checks who is asking and builds the
 * params from the room as it is at that moment, or refuses. Returns the
 * full EngineResult - callers need the `state` too, to broadcast it. */
export async function startAndSaveGame(
	code: string,
	prepare: () => Promise<StartGameParams | Refusal>
): Promise<EngineResult | Refusal> {
	return withRoomLock(code, async () => {
		const params = await prepare();
		if ('ok' in params) return params;
		const result = startGame(params);
		await saveGameState(code, result.state);
		return result;
	});
}

/** What a caller hands applyGameAction: the action itself, or a function
 * that decides it from the current state (inside the lock) - returning a
 * refusal instead when the action isn't allowed right now. */
export type ActionInput = EngineAction | ((state: GameState) => EngineAction | Refusal);

export type ApplyResult =
	| { refused: Refusal }
	| {
			/** The state right before this action, for telling a real
			 * transition apart from an action that left things alone. */
			previous: GameState;
			result: EngineResult;
	  };

/** The engine's steady-state entry point from the IO shell: load -> decide
 * -> reduce -> save, all under one lock acquisition so the read and
 * the write can never straddle someone else's write. A refusal saves
 * nothing. `authorize` (e.g. a Host check) runs under the same lock first.
 * Throws ActionError('game_not_started') if this room has no game in
 * progress. */
export async function applyGameAction(
	code: string,
	input: ActionInput,
	authorize?: () => Promise<Refusal | null>
): Promise<ApplyResult> {
	return withRoomLock(code, async () => {
		const refusal = authorize ? await authorize() : null;
		if (refusal) return { refused: refusal };
		const state = await loadGameState(code);
		if (!state) throw new ActionError('game_not_started');
		const action = typeof input === 'function' ? input(state) : input;
		if ('ok' in action) return { refused: action };
		const result = reduce(state, action);
		await saveGameState(code, result.state);
		return { previous: state, result };
	});
}
