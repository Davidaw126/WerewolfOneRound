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
import { ROOM_TTL_SECONDS, gameStateKey, gameLockKey, gameActionsKey } from '../rooms/keys';
import { reduce, startGame, type StartGameParams } from '../../game/engine';
import type { EngineAction, EngineResult, GameState } from '../../game/types';
import { ActionError } from '../socket/actionError';
import { mapToLegacyPhase } from './projection';
import type { Phase as LegacyPhase } from '../../shared/gameTypes';

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

async function withGameLock<T>(code: string, fn: () => Promise<T>): Promise<T> {
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

async function saveGameState(code: string, state: GameState): Promise<void> {
	await redis.set(gameStateKey(code), JSON.stringify(state), 'EX', ROOM_TTL_SECONDS);
}

export async function deleteGameState(code: string): Promise<void> {
	await redis.del(gameStateKey(code));
}

async function appendGameAction(code: string, action: EngineAction, at: number): Promise<void> {
	await redis.rpush(gameActionsKey(code), JSON.stringify({ action, at }));
	await redis.expire(gameActionsKey(code), ROOM_TTL_SECONDS);
}

export async function clearGameActions(code: string): Promise<void> {
	await redis.del(gameActionsKey(code));
}

/** Deals the opening GameState (via the engine's own `startGame`) and
 * persists it - the one-time entry point `RoomStartGame` calls instead of
 * every later `applyGameAction`. Locked for consistency with every other
 * write to this room's state, even though only the host can trigger it.
 * Returns the full EngineResult (not just effects) - callers need the final
 * `state` too, to sync the legacy room-hash phase and broadcast it. */
export async function startAndSaveGame(
	code: string,
	params: StartGameParams
): Promise<EngineResult> {
	return withGameLock(code, async () => {
		const result = startGame(params);
		await saveGameState(code, result.state);
		return result;
	});
}

export interface ApplyResult {
	result: EngineResult;
	/** The legacy-mapped phase from BEFORE this action ran - gameSync.ts uses
	 * this to tell a real phase transition apart from an action (e.g. a vote
	 * cast) that left the phase alone, so PhaseChanged only ever broadcasts on
	 * an actual change. */
	previousLegacyPhase: LegacyPhase;
}

/** The engine's steady-state entry point from the IO shell: load -> reduce ->
 * save -> log, all under one lock acquisition so the read and the write can
 * never straddle someone else's write. Throws ActionError('game_not_started')
 * if this room has no game in progress - every call site already gates on
 * the room being in an in-game phase before it gets here, so that should
 * only ever fire on a genuine bug, not routine player action. */
export async function applyGameAction(
	code: string,
	action: EngineAction,
	now: number
): Promise<ApplyResult> {
	return withGameLock(code, async () => {
		const state = await loadGameState(code);
		if (!state) throw new ActionError('game_not_started');
		const previousLegacyPhase = mapToLegacyPhase(state);
		const result = reduce(state, action);
		await saveGameState(code, result.state);
		await appendGameAction(code, action, now);
		return { result, previousLegacyPhase };
	});
}
