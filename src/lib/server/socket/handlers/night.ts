import { loadGameState } from '../../game/gameStateRepo';
import { runGameAction } from '../../game/gameSync';
import { stageOf } from '../../game/projection';
import { currentStage, currentStageRole } from '../../../game/rules/stage';
import { emitToRoom } from '../emit';
import { refuse, type AckResponse, type NightActionSubmission } from '../../../shared/events';
import type { NightActions, Player, RoleId } from '../../../game/types';
import { requireRoomCode, requireSeat, requireHost, type GameSocket } from './helpers';

// The pause after a finished turn, the 假环节 timing and the stale-timer
// guard all live in gameSync.ts's runGameAction.

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
		case 'WEREWOLF':
		case 'WOLF_KING': // shares the pack's collective kill decision - see roleMeta.ts
		case 'BLACK_WOLF_KING':
			return { wolfKillTarget: action.targetSeat };
		case 'SEER':
			return { seerCheckTarget: action.targetSeat };
		case 'WITCH':
			return {
				witchPoisonTarget: action.poisonTarget ?? undefined,
				witchAntidoteTarget: action.useAntidote ? 0 : undefined
			};
		case 'GUARD':
			return { guardTarget: action.targetSeat };
		case 'WOLF_BEAUTY':
			return { wolfBeautyCharmTarget: action.targetSeat ?? undefined };
		case 'CUPID':
			return { cupidLinks: [action.seatA, action.seatB] };
		case 'THIEF': {
			if (!action.swap) return {};
			const idx = action.swap === 'buried1' ? 0 : 1;
			const pick = player.thiefExtraCards?.[idx];
			return pick ? { thiefPick: pick } : {};
		}
		case 'WILD_CHILD':
			return { wildChildIdol: action.targetSeat };
		case 'DREAM_WEAVER':
			return { dreamWeaverTarget: action.targetSeat };
		case 'NIGHTMARE':
			return { nightmareFearTarget: action.targetSeat ?? undefined };
	}
}

export async function handleNightSubmitAction(
	socket: GameSocket,
	action: NightActionSubmission
): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	const seat = await requireSeat(code, socket.data.sessionId);

	return runGameAction(code, (state) => {
		// The server-side role-match check that closed the old app's cheating
		// vector: a client can only ever submit an action for the role they
		// were actually dealt, never an arbitrary claimed role. Read from the
		// LIVE GameState, not a static identities snapshot - a 盗贼 swap changes
		// this mid-game, and this must reflect that.
		const roleId = action.role;
		const player = state.players[seat];
		if (!player || player.role !== roleId) {
			return refuse('not_your_role');
		}
		// In the pack's kill turn every wolf's pick is the kill - a 狼美人 or
		// 恶灵骑士 would otherwise be read as their own skill's target.
		const nightAction =
			currentStageRole(state) === 'WEREWOLF' && 'targetSeat' in action
				? { wolfKillTarget: action.targetSeat }
				: buildNightAction(action, player);
		return { type: 'SUBMIT_NIGHT_ACTION', seat, role: roleId, action: nightAction };
	});
}

/** A feared player (恶灵骑士) ends their turn without acting. The engine only
 * accepts it for a seat that really is feared tonight, and it goes through
 * the same auto-advance as a real action, so the pause is indistinguishable. */
export async function handleNightPass(socket: GameSocket): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	const seat = await requireSeat(code, socket.data.sessionId);
	return runGameAction(code, (state) => {
		const player = state.players[seat];
		if (!player) return refuse('not_your_role');
		if (state.fearedSeat !== seat) return refuse('not_feared');
		return { type: 'SUBMIT_NIGHT_ACTION', seat, role: player.role, action: {} };
	});
}

export async function handleNightConfirmStage(socket: GameSocket): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	const seat = await requireSeat(code, socket.data.sessionId);
	return runGameAction(
		code,
		{ type: 'CONFIRM_STAGE', seat },
		{
			// 情侣相认 shows the same button on every phone, so a non-lover's tap
			// must look exactly like a lover's - no error popup to give it away.
			ignored: (state) =>
				currentStage(state)?.kind === 'COUPLE_REVEAL' ? { ok: true } : refuse('not_your_turn')
		}
	);
}

export async function handleNightAdvanceStage(socket: GameSocket): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	return runGameAction(
		code,
		{ type: 'ADVANCE_STAGE' },
		{ ignored: 'invalid_phase', host: socket.data.sessionId }
	);
}

/** Relays "this role's narration line just started speaking" from the host's
 * device to the whole room, so every client's NightActionPrompt for that role
 * can stop waiting and actually show itself in sync with the voice - see
 * gameStore's pendingTurnRole. Read-only (no lock needed): this never
 * mutates GameState, only compares against its current stage. */
export async function handleNightNarrationStarted(
	socket: GameSocket,
	role: RoleId
): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
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
	const code = await requireRoomCode(socket);
	// A genuine no-op (nothing was pending, or a double-tap race) produces
	// zero effects - see engine.ts's early-return guard.
	return runGameAction(
		code,
		{ type: 'ANNOUNCE_NIGHT_RESULTS' },
		{ ignored: 'nothing_to_announce', host: socket.data.sessionId }
	);
}
