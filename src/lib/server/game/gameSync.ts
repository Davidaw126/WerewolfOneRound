// The game-action module: the one path every engine write takes from a
// handler (or a pacing timer) out to the phones.
//
//   runGameAction(code, action) -> lock, decide, reduce, save (gameStateRepo)
//     -> interpret the result: a night-rule rejection or an ignored action
//        becomes an error ack, anything else ok
//     -> mirror the game's phase into the room (roomRepo.recordGamePhase),
//        broadcast PhaseChanged only when the legacy-mapped phase actually
//        changed (an unconditional re-broadcast on every vote cast would
//        retrigger anything the client keys off phase, like narration)
//     -> hand every other effect to the translator
//     -> arm the night's pacing timers.
//
// Handlers only check who is asking (requireHost / requireSeat) and say what
// they want; everything after that lives here. Messages go out through
// socket/emit.ts's io instance and timers through setTimeout, so tests run
// this module with a fake io and fake timers.

import { redis } from '../redis';
import { recordGamePhase } from '../rooms/roomRepo';
import { emitToRoom } from '../socket/emit';
import type { EngineResult, GameState, RoleId } from '../../game/types';
import type { AckResponse } from '../../shared/events';
import { actsInStage, PACK_KILL_ROLES, STATUS_STAGE_ROLES } from '../../game/roleMeta';
import { stageConfirmComplete, type StartGameParams } from '../../game/engine';
import { mapToLegacyPhase } from './projection';
import { translateEffects } from './effectTranslator';
import {
	applyGameAction,
	loadGameState,
	startAndSaveGame,
	type ActionInput
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

function roleHasLivingHolder(state: GameState, role: RoleId): boolean {
	// actsInStage, not role equality: a lone surviving wolf king is the real
	// holder of the WEREWOLF stage, not an absent role to auto-skip.
	return Object.values(state.players).some((p) => !p.isDead && actsInStage(role, p.role));
}

const isNight = (state: GameState) => state.phase === 'NIGHT' || state.phase === 'FIRST_NIGHT';

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
	const key = state.currentStepKey;
	if (!key || !key.startsWith('role:')) return;
	const role = key.slice('role:'.length) as RoleId;
	// Not only the always-announced roles: any stage can lose its last holder
	// mid-turn (上帝之手 kills or recasts them), and that stage must not freeze.
	if (roleHasLivingHolder(state, role)) return;

	scheduleAdvance(code, key, fakeStageDurationMs(role));
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

/** The current night stage got everything it waits for (a submission, or
 * every 确认) and only the pause before the next role is left. */
function stageFinished(state: GameState): boolean {
	const key = state.currentStepKey;
	if (!key) return false;
	if (key === 'couple_reveal') return stageConfirmComplete(state);
	const role = key.slice('role:'.length) as RoleId;
	if (STATUS_STAGE_ROLES.has(role)) return stageConfirmComplete(state);
	if (role === 'WEREWOLF') return state.submittedRoles.some((r) => PACK_KILL_ROLES.has(r));
	return state.submittedRoles.includes(role);
}

/** Arms whatever the night now waits on: the pause before the next role
 * when this action just finished the stage (a submission, the last 确认),
 * or the made-up turn length of a stage nobody alive can take. */
function scheduleNightTimers(code: string, before: GameState | null, after: GameState): void {
	if (!isNight(after)) return;
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
	const legacyPhase = mapToLegacyPhase(result.state);
	await recordGamePhase(code, legacyPhase, result.state.round);
	if (before === null || legacyPhase !== mapToLegacyPhase(before)) {
		emitToRoom(code, { kind: 'PhaseChanged', phase: legacyPhase, nightNumber: result.state.round });
	}
	await translateEffects(code, result.effects);
	scheduleNightTimers(code, before, result.state);
}

export interface RunOptions {
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
	const applied = await applyGameAction(code, input, Date.now());
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
 * room - the one-time counterpart of runGameAction for RoomStartGame. */
export async function startGameAndBroadcast(code: string, params: StartGameParams): Promise<void> {
	const result = await startAndSaveGame(code, params);
	await syncAndBroadcast(code, null, result);
}
