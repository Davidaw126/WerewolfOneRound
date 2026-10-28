// The game-action module: the one path every engine write takes from a
// handler (or a pacing timer) out to the phones.
//
//   runGameAction(code, action) -> lock, decide, reduce, save (gameStateRepo)
//     -> interpret the result: a night-rule rejection or an ignored action
//        becomes an error ack, anything else ok
//     -> mirror the game's phase into the room (roomRepo.recordGamePhase),
//        broadcast PhaseChanged only when the phase actually changed (an
//        unconditional re-broadcast on every vote cast would retrigger
//        anything the client keys off phase, like narration)
//     -> hand every other effect to the translator, then tell the room who
//        is dead if that changed (DeathsUpdated - the phones' only source)
//     -> arm the night's pacing timers.
//
// Handlers only check who is asking (requireHost / requireSeat) and say what
// they want; everything after that lives here. Messages go out through
// socket/emit.ts's io instance and timers through setTimeout, so tests run
// this module with a fake io and fake timers.

import { redis } from '../redis';
import { recordGamePhase, isHost, readRoomHash } from '../rooms/roomRepo';
import { emitToRoom } from '../socket/emit';
import type { EngineResult, GameState, RoleId } from '../../game/types';
import type { AckResponse } from '../../shared/events';
import { STATUS_STAGE_ROLES } from '../../game/roleMeta';
import type { StartGameParams } from '../../game/engine';
import {
	currentStageRole,
	isNightPhase,
	roleHasLivingHolder,
	stageFinished
} from '../../game/rules/stage';
import { translateEffects } from './effectTranslator';
import { deadSeatsOf, revealedIdiotsOf } from './projection';
import {
	applyGameAction,
	loadGameState,
	startAndSaveGame,
	type ActionInput,
	type Refusal
} from './gameStateRepo';

const randomMs = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

/** The beat after a finished turn (an action submitted, a 确认 tapped)
 * before the next role is called: 3-5 s, random each time, so the gap
 * doesn't tick like a metronome the table can count. */
function postActionPauseMs(): number {
	return randomMs(3000, 5000);
}

/** §8.5 假环节: a turn with nobody alive to take it must last about as long
 * as a real one, or a short turn tells the table that role is dead. A real
 * turn is the call-out + the player thinking + the post-action pause, so a
 * fake one waits a made-up think time on top of that same pause: short for
 * a 确认开枪状态 glance, longer for a real decision - a real 预言家 or 女巫
 * usually takes a while, so the old 10 s ceiling ran noticeably short.
 * In total 6-10 s for a status glance, 9-15 s for a decision. */
function fakeStageDurationMs(role: RoleId): number {
	const think = STATUS_STAGE_ROLES.has(role) ? randomMs(3000, 5000) : randomMs(6000, 10000);
	return think + postActionPauseMs();
}

/** §8.5 假环节: a stage for a role with no living holder never gets a
 * submission to finish it, so this schedules the same pacing beat directly
 * on stage ENTRY instead - a fake stage still takes a consistent, realistic
 * amount of time before moving on, exactly like a real one, instead of
 * sitting frozen until the host happens to notice and tap through it. A REAL
 * 猎人 stage waits for its holder's 确认 like any status stage, but a FAKE
 * one must still auto-advance like the other always-announced roles, or its
 * absence would be the one stage that visibly stalls every night. Safe to
 * call on every sync: a redundant/stale timer's expectedStepKey simply won't
 * match by the time it fires if the stage already moved on. */
function maybeScheduleFakeStageAdvance(code: string, state: GameState): void {
	const role = currentStageRole(state);
	if (!role) return;
	// Not only the always-announced roles: any stage can lose its last holder
	// mid-turn (上帝之手 kills or recasts them), and that stage must not freeze.
	if (roleHasLivingHolder(state, role)) return;

	scheduleAdvance(code, state.currentStepKey, fakeStageDurationMs(role));
}

/** Moves the night on from `expectedStepKey` after `ms` - a no-op if the
 * stage has already moved on by then (the host advanced it, or another
 * timer won the race). */
function scheduleAdvance(code: string, expectedStepKey: string | null, ms: number): void {
	setTimeout(() => {
		runGameAction(code, { type: 'ADVANCE_STAGE', expectedStepKey }).catch((err) =>
			console.error('auto-advance failed', err)
		);
	}, ms);
}

/** Arms whatever the night now waits on: the pause before the next role
 * when this action just finished the stage (a submission, the last 确认),
 * or the made-up turn length of a stage nobody alive can take. */
function scheduleNightTimers(code: string, before: GameState | null, after: GameState): void {
	if (!isNightPhase(after)) return;
	const alreadyFinished =
		before !== null && before.currentStepKey === after.currentStepKey && stageFinished(before);
	if (stageFinished(after) && !alreadyFinished) {
		scheduleAdvance(code, after.currentStepKey, postActionPauseMs());
	}
	maybeScheduleFakeStageAdvance(code, after);
}

/** The pacing timers live in memory, so a server restart (a deploy during a
 * game) dropped them and the night sat still until the host forced it on.
 * On startup, re-arm whatever each running night was waiting on. */
export async function resumeNightTimers(): Promise<void> {
	let cursor = '0';
	do {
		const [next, keys] = await redis.scan(cursor, 'MATCH', 'wolf:room:*:gameState', 'COUNT', 100);
		cursor = next;
		for (const key of keys) {
			const code = key.slice('wolf:room:'.length, -':gameState'.length);
			const state = await loadGameState(code);
			if (state) scheduleNightTimers(code, null, state);
		}
	} while (cursor !== '0');
}

/** Phase mirror, PhaseChanged on a real transition, every other effect to
 * the translator, then the night's timers. `before` is null at game start,
 * where there's no earlier game phase to compare against. */
async function syncAndBroadcast(
	code: string,
	before: GameState | null,
	result: EngineResult
): Promise<void> {
	const phase = result.state.phase;
	await recordGamePhase(code, phase, result.state.round);
	if (before === null || phase !== before.phase) {
		emitToRoom(code, { kind: 'PhaseChanged', phase, nightNumber: result.state.round });
	}
	await translateEffects(code, result.effects);
	const deadSeats = deadSeatsOf(result.state);
	const revealedIdiots = revealedIdiotsOf(result.state);
	if (
		before === null ||
		!sameSeats(deadSeats, deadSeatsOf(before)) ||
		!sameSeats(revealedIdiots, revealedIdiotsOf(before))
	) {
		emitToRoom(code, { kind: 'DeathsUpdated', deadSeats, revealedIdiots });
	}
	scheduleNightTimers(code, before, result.state);
}

const sameSeats = (a: number[], b: number[]) =>
	a.length === b.length && a.every((s, i) => s === b[i]);

const NOT_HOST: Refusal = { ok: false, error: 'not_host' };

/** A Host check that runs under the room lock, together with the write. */
function hostCheck(code: string, sessionId: string): () => Promise<Refusal | null> {
	return async () => ((await isHost(code, sessionId)) ? null : NOT_HOST);
}

export interface RunOptions {
	/** Host-only: the asking session, checked under the room lock. */
	host?: string;
	/** What to answer when the engine ignored the action (no effects at all:
	 * wrong phase, a double tap, a seat it can't apply to). Without this an
	 * ignored action still answers ok. */
	ignored?: string | ((state: GameState) => AckResponse);
}

/** Runs one game action end to end and answers the caller's ack. */
export async function runGameAction(
	code: string,
	input: ActionInput,
	options: RunOptions = {}
): Promise<AckResponse> {
	const authorize = options.host === undefined ? undefined : hostCheck(code, options.host);
	const applied = await applyGameAction(code, input, Date.now(), authorize);
	if ('refused' in applied) return applied.refused;
	const { previous, result } = applied;

	// A night-rule violation comes back as a NightActionRejected PRIVATE
	// effect for the submitter, and is the ONLY effect such a submission
	// produces - it becomes the ack's error instead of anything sent.
	const rejection = result.effects.find(
		(e) => (e.payload as { kind?: string })?.kind === 'NightActionRejected'
	);
	if (rejection) return { ok: false, error: (rejection.payload as { error: string }).error };

	if (result.effects.length === 0 && options.ignored !== undefined) {
		return typeof options.ignored === 'string'
			? { ok: false, error: options.ignored }
			: options.ignored(result.state);
	}

	await syncAndBroadcast(code, previous, result);
	return { ok: true };
}

/** Deals the opening GameState from what seating produced and tells the
 * room - the one-time counterpart of runGameAction for RoomStartGame. With
 * `host`, only that Host may start, and only with the seats still locked,
 * both checked under the room lock. */
export async function startGameAndBroadcast(
	code: string,
	params: StartGameParams,
	host?: string
): Promise<AckResponse> {
	const authorize =
		host === undefined
			? undefined
			: async (): Promise<Refusal | null> => {
					if (!(await isHost(code, host))) return NOT_HOST;
					const room = await readRoomHash(code);
					return room?.lockStatus ? null : { ok: false, error: 'seats_not_locked' };
				};
	const result = await startAndSaveGame(code, params, authorize);
	if ('ok' in result) return result;
	await syncAndBroadcast(code, null, result);
	return { ok: true };
}
