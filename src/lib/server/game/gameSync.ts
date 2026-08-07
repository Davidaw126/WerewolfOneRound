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
import { ALWAYS_ANNOUNCED_ROLES } from '../../game/rules/nightOrder';
import { mapToLegacyPhase } from './projection';
import { translateEffects } from './effectTranslator';
import { applyGameAction } from './gameStateRepo';

async function writeLegacyPhase(
	code: string,
	legacyPhase: LegacyPhase,
	round: number
): Promise<void> {
	await redis.hset(roomKey(code), { phase: legacyPhase, nightNumber: String(round) });
	await touchRoomTtl(code);
}

// Same pacing beat as night.ts's POST_ACTION_PAUSE_MS (submission-triggered
// auto-advance) - §8.5 假环节 requires a fake stage to take a duration
// consistent with a real one's, and this app already treats this as that
// beat everywhere else. The two MUST stay equal: a fake stage timed
// differently from a real one would itself become a timing side-channel a
// player could use to infer who's actually there.
const FAKE_STAGE_PAUSE_MS = 4000;

function roleHasLivingHolder(state: GameState, role: RoleId): boolean {
	return Object.values(state.players).some((p) => !p.isDead && p.role === role);
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
	if (!ALWAYS_ANNOUNCED_ROLES.has(role)) return; // a non-P0 stage always has a living holder by construction
	if (roleHasLivingHolder(state, role)) return; // real stage - HUNTER waits for the host; every other role's submission-triggered timer (night.ts) handles it

	setTimeout(() => {
		applyGameAction(code, { type: 'ADVANCE_STAGE', expectedStepKey: key }, Date.now())
			.then(({ result, previousLegacyPhase }) =>
				syncAndBroadcast(code, result, previousLegacyPhase)
			)
			.catch((err) => console.error('fake-stage auto-advance failed', err));
	}, FAKE_STAGE_PAUSE_MS);
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
