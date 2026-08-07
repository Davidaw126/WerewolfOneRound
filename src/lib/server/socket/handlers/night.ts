import { applyGameAction, loadGameState } from '../../game/gameStateRepo';
import { syncAndBroadcast } from '../../game/gameSync';
import { legacyToRoleId } from '../../../game/roleBridge';
import { stageOf } from '../../game/projection';
import { emitToRoom } from '../emit';
import type { AckResponse, NightActionSubmission } from '../../../shared/events';
import type { Role } from '../../../shared/roles';
import type { NightActions, Player } from '../../../game/types';
import { requireRoomCode, requireSeat, requireHost, type GameSocket } from './helpers';

// Small pacing beat after a player's night action, before the next role gets
// prompted (or the night resolves) - gives the group a moment to notice the
// turn actually changed, rather than the next prompt appearing instantly. In
// practice this also gives the host device's narration line for the role
// that just acted time to finish speaking before the next one is queued,
// since acting always takes longer than the ~1-2s these lines take to speak.
// Ported from the pre-M1 stateMachine.ts, which this app's actual live flow
// still depends on - losing it would mean the host has to manually tap
// "advance" after every single role's turn, all night. MUST stay equal to
// gameSync.ts's FAKE_STAGE_PAUSE_MS - see that constant's own comment.
const POST_ACTION_PAUSE_MS = 4000;

/** Not awaited by the caller - the pause is pacing for the *next* prompt, not
 * part of the submitting player's own acknowledgment, so it must not extend
 * how long their NightSubmitAction ack takes to come back. `expectedStepKey`
 * (captured right after the submission that triggered this) is what keeps a
 * stale timer - one that fires after the host already manually advanced, or
 * after a different player's own timer already won the race - from
 * double-advancing past whatever stage came next. */
function scheduleAutoAdvance(code: string, expectedStepKey: string | null): void {
	setTimeout(() => {
		applyGameAction(code, { type: 'ADVANCE_STAGE', expectedStepKey }, Date.now())
			.then(({ result, previousLegacyPhase }) =>
				syncAndBroadcast(code, result, previousLegacyPhase)
			)
			.catch((err) => console.error('scheduleAutoAdvance failed', err));
	}, POST_ACTION_PAUSE_MS);
}

/**
 * Old wire shape -> the engine's NightActions. Two fields are worth a note:
 *  - witch.witchAntidoteTarget: the engine only checks whether this key is
 *    PRESENT to know "did they use the antidote" - it always recomputes and
 *    persists the real target itself from tonight's wolf kill (see
 *    engine.ts's WITCH case / nightRules.ts), discarding whatever value
 *    arrives here. `0` is just an ignored presence marker, never persisted.
 *  - thief.swap: the old wire only ever sends which BURIED SLOT ('buried1'/
 *    'buried2'), not the role itself - resolved here against the acting
 *    player's own `thiefExtraCards`, which is why this needs `player`, not
 *    just the submission.
 */
function buildNightAction(action: NightActionSubmission, player: Player): Partial<NightActions> {
	switch (action.role) {
		case '普通狼人':
		case '白狼王': // shares 普通狼人's collective kill decision - see roleMeta.ts
			return { wolfKillTarget: action.targetSeat };
		case '预言家':
			return { seerCheckTarget: action.targetSeat };
		case '女巫':
			return {
				witchPoisonTarget: action.poisonTarget ?? undefined,
				witchAntidoteTarget: action.useAntidote ? 0 : undefined
			};
		case '守卫':
			return { guardTarget: action.targetSeat };
		case '狼美人':
			return { wolfBeautyCharmTarget: action.targetSeat };
		case '丘比特':
			return { cupidLinks: [action.seatA, action.seatB] };
		case '盗贼': {
			if (!action.swap) return {};
			const idx = action.swap === 'buried1' ? 0 : 1;
			const pick = player.thiefExtraCards?.[idx];
			return pick ? { thiefPick: pick } : {};
		}
		case '野孩子':
			return { wildChildIdol: action.targetSeat };
		case '摄梦人':
			return { dreamWeaverTarget: action.targetSeat };
		case '恶灵骑士':
			return { nightmareFearTarget: action.targetSeat };
	}
}

export async function handleNightSubmitAction(
	socket: GameSocket,
	action: NightActionSubmission
): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	const seat = await requireSeat(code, socket.data.sessionId);

	const state = await loadGameState(code);
	if (!state) return { ok: false, error: 'game_not_started' };

	// The server-side role-match check that closed the old app's cheating
	// vector: a client can only ever submit an action for the role they were
	// actually dealt, never an arbitrary claimed role. Read from the LIVE
	// GameState, not a static identities snapshot - a 盗贼 swap changes this
	// mid-game, and this must reflect that.
	const roleId = legacyToRoleId(action.role);
	const player = state.players[seat];
	if (!roleId || !player || player.role !== roleId) {
		return { ok: false, error: 'not_your_role' };
	}

	const { result, previousLegacyPhase } = await applyGameAction(
		code,
		{ type: 'SUBMIT_NIGHT_ACTION', seat, role: roleId, action: buildNightAction(action, player) },
		Date.now()
	);

	// A rejected action (rule violation) surfaces as a NightActionRejected
	// PRIVATE effect targeting the submitter, never a room broadcast - matches
	// the old app's submitNightAction returning {ok:false,error} straight from
	// the ack instead of pushing an event. A rejection is the ONLY effect a
	// failed submission ever produces (engine.ts's `reject()` returns before
	// anything else runs), so there's nothing else here to translate either way.
	const rejection = result.effects.find(
		(e) => e.seat === seat && (e.payload as { kind?: string })?.kind === 'NightActionRejected'
	);
	if (rejection) {
		return { ok: false, error: (rejection.payload as { error: string }).error };
	}

	await syncAndBroadcast(code, result, previousLegacyPhase);

	// HUNTER's turn is informational only (§4.2 HUNTER_STATUS) - nobody ever
	// submits an action for it, so this branch is unreachable for that role
	// today, but the exclusion is spelled out for when that changes. Every
	// other role that reaches here just submitted a real decision, so the
	// stage should move on without the host needing to tap anything.
	if (roleId !== 'HUNTER') {
		scheduleAutoAdvance(code, result.state.currentStepKey);
	}

	return { ok: true };
}

export async function handleNightAdvanceStage(socket: GameSocket): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	const { result, previousLegacyPhase } = await applyGameAction(
		code,
		{ type: 'ADVANCE_STAGE' },
		Date.now()
	);
	await syncAndBroadcast(code, result, previousLegacyPhase);
	return { ok: true };
}

/** Relays "this role's narration line just started speaking" from the host's
 * device to the whole room, so every client's NightActionPrompt for that role
 * can stop waiting and actually show itself in sync with the voice - see
 * gameStore's pendingTurnRole. Read-only (no lock needed): this never
 * mutates GameState, only compares against its current stage. */
export async function handleNightNarrationStarted(
	socket: GameSocket,
	role: Role
): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);

	const state = await loadGameState(code);
	const stage = state ? stageOf(state) : null;
	// Stale signal (e.g. the host manually advanced past this stage before
	// their queued narration line got around to playing) - don't resurrect a
	// prompt for a role that's no longer live.
	if (!stage || stage.kind !== 'ROLE_TURN' || stage.role !== role) return { ok: true };

	// S4: no role in the broadcast - see StageNarrationStarted's own comment.
	emitToRoom(code, { kind: 'StageNarrationStarted' });
	return { ok: true };
}

export async function handleNightAnnounceResults(socket: GameSocket): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);

	const { result, previousLegacyPhase } = await applyGameAction(
		code,
		{ type: 'ANNOUNCE_NIGHT_RESULTS' },
		Date.now()
	);
	// A genuine no-op (nothing was pending, or a double-tap race) produces
	// zero effects - see engine.ts's early-return guard.
	if (result.effects.length === 0) return { ok: false, error: 'nothing_to_announce' };

	await syncAndBroadcast(code, result, previousLegacyPhase);
	return { ok: true };
}
