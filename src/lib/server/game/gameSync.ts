// The one place every engine write funnels through on its way back out to
// sockets: keep the legacy room-hash `phase`/`nightNumber` fields (still the
// source of truth for RoomManager-scope logic like handleRoomLeave's
// IN_PROGRESS_PHASES check) in sync with the new GameState, broadcast
// PhaseChanged only when the legacy-mapped phase actually changed (an
// unconditional re-broadcast on every single player action - e.g. every
// vote cast - would retrigger anything the client keys off phase, like
// narration, on every one of those actions instead of just real
// transitions), then hand every other effect to the translator.

import { redis } from '../redis';
import { roomKey } from '../rooms/keys';
import { touchRoomTtl } from '../rooms/roomRepo';
import { emitToRoom } from '../socket/emit';
import type { EngineResult, GameState, RoleId } from '../../game/types';
import type { Phase as LegacyPhase } from '../../shared/gameTypes';
import { actsInStage, PACK_KILL_ROLES, STATUS_STAGE_ROLES } from '../../game/roleMeta';
import { stageConfirmComplete } from '../../game/engine';
import { mapToLegacyPhase } from './projection';
import { translateEffects } from './effectTranslator';
import { applyGameAction, loadGameState } from './gameStateRepo';

async function writeLegacyPhase(
	code: string,
	legacyPhase: LegacyPhase,
	round: number
): Promise<void> {
	await redis.hset(roomKey(code), { phase: legacyPhase, nightNumber: String(round) });
	await touchRoomTtl(code);
}

const randomMs = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

/** The beat after a finished turn (an action submitted, a 确认 tapped)
 * before the next role is called: 3-5 s, random each time, so the gap
 * doesn't tick like a metronome the table can count. */
export function postActionPauseMs(): number {
	return randomMs(3000, 5000);
}

/** §8.5 假环节: a turn with nobody alive to take it must last about as long
 * as a real one, or a short turn tells the table that role is dead. A real
 * turn is the call-out + the player thinking + the post-action pause, so a
 * fake one waits a made-up think time on top of that same pause: short for
 * a 确认开枪状态 glance, longer for a real decision. Never more than 10 s in
 * total (5-8 s for a status glance, 6-10 s for a decision). */
function fakeStageDurationMs(role: RoleId): number {
	const think = STATUS_STAGE_ROLES.has(role) ? randomMs(2000, 3000) : randomMs(3000, 5000);
	return think + postActionPauseMs();
}

function roleHasLivingHolder(state: GameState, role: RoleId): boolean {
	// actsInStage, not role equality: a lone surviving wolf king is the real
	// holder of the WEREWOLF stage, not an absent role to auto-skip.
	return Object.values(state.players).some((p) => !p.isDead && actsInStage(role, p.role));
}

/** §8.5 假环节: a stage for a role with no living holder never gets a
 * submission to trigger night.ts's usual post-action auto-advance, so this
 * schedules the same pacing beat directly on stage ENTRY instead - a fake
 * stage still takes a consistent, predictable amount of time before moving
 * on, exactly like a real one, instead of sitting frozen until the host
 * happens to notice and tap through it manually. HUNTER is the one role
 * whose REAL stage is host-driven regardless (its "turn" is the host
 * confirming a live thumbs up/down gesture, not a decision to wait out - see
 * night.ts's own note) - but a FAKE Hunter stage (no living holder) must
 * still auto-advance exactly like the other 4 always-announced roles, or its
 * absence would be the one stage that visibly stalls every single night,
 * defeating the whole point of 假环节. The `roleHasLivingHolder` check below
 * is what tells those two cases apart - it must run before, not instead of,
 * the HUNTER-specific behavior. Safe to call on every single sync, real
 * stage or not: a redundant/stale timer's expectedStepKey simply won't match
 * by the time it fires if the stage already moved on. */
function maybeScheduleFakeStageAdvance(code: string, state: GameState): void {
	const key = state.currentStepKey;
	if (!key || !key.startsWith('role:')) return;
	const role = key.slice('role:'.length) as RoleId;
	// Not only the always-announced roles: any stage can lose its last holder
	// mid-turn (上帝之手 kills or recasts them), and that stage must not freeze.
	if (roleHasLivingHolder(state, role)) return; // real stage - HUNTER waits for the host; every other role's submission-triggered timer (night.ts) handles it

	scheduleAdvance(code, key, fakeStageDurationMs(role));
}

/** Moves the night on from `expectedStepKey` after `ms` - a no-op if the
 * stage has already moved on by then (the host advanced it, or another
 * timer won the race). */
export function scheduleAdvance(code: string, expectedStepKey: string | null, ms: number): void {
	setTimeout(() => {
		applyGameAction(code, { type: 'ADVANCE_STAGE', expectedStepKey }, Date.now())
			.then(({ result, previousLegacyPhase }) =>
				syncAndBroadcast(code, result, previousLegacyPhase)
			)
			.catch((err) => console.error('auto-advance failed', err));
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
			if (!state || (state.phase !== 'NIGHT' && state.phase !== 'FIRST_NIGHT')) continue;
			if (stageFinished(state)) scheduleAdvance(code, state.currentStepKey, postActionPauseMs());
			else maybeScheduleFakeStageAdvance(code, state);
		}
	} while (cursor !== '0');
}

/** Used by every steady-state action (night submit/advance/announce, vote
 * cast/end, hunter shoot) - `previousLegacyPhase` is what the room hash said
 * right before this action ran (captured by applyGameAction), so this can
 * tell a real transition apart from an action that left the phase alone. */
export async function syncAndBroadcast(
	code: string,
	result: EngineResult,
	previousLegacyPhase: LegacyPhase
): Promise<void> {
	const legacyPhase = mapToLegacyPhase(result.state);
	await writeLegacyPhase(code, legacyPhase, result.state.round);
	if (legacyPhase !== previousLegacyPhase) {
		emitToRoom(code, { kind: 'PhaseChanged', phase: legacyPhase, nightNumber: result.state.round });
	}
	await translateEffects(code, result.effects);
	maybeScheduleFakeStageAdvance(code, result.state);
}

/** Used once, by RoomStartGame - there's no "previous" GameState to diff
 * against (the room was in SEATING, which is never what a fresh game maps
 * to), so this always broadcasts. */
export async function syncAndBroadcastGameStart(code: string, result: EngineResult): Promise<void> {
	const legacyPhase = mapToLegacyPhase(result.state);
	await writeLegacyPhase(code, legacyPhase, result.state.round);
	emitToRoom(code, { kind: 'PhaseChanged', phase: legacyPhase, nightNumber: result.state.round });
	await translateEffects(code, result.effects);
	maybeScheduleFakeStageAdvance(code, result.state);
}
