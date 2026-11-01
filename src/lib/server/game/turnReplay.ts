// Re-delivers what a client may have missed: most of all a night-turn prompt.
//
// YourTurnPrompt is a one-shot private emit, sent the instant a stage
// begins. A phone whose socket was down at that moment - iOS Safari drops
// the WebSocket within seconds of the screen locking or the tab going to the
// background, which is exactly what happens to a phone lying face-down
// during the night - never receives it, and nothing ever sent it again: the
// player's action panel simply never appeared for the rest of that turn.
// RoomJoin (full reload) and ResyncRequest (socket reconnect) both call this
// so a returning client gets its prompt, role and results back.
//
// Same SECURITY invariant as turnContext.ts: everything built here goes only
// to the one session that holds the seat, via translateEffects' PRIVATE path.

import type { GameState, Player } from '../../game/types';
import { loadGameState } from './gameStateRepo';
import { emitToSession } from '../socket/emit';
import { translateEffects } from './effectTranslator';
import { notifyRoleHolders } from '../../game/rules/turnContext';
import { currentStageRole, isNightPhase, turnUsed } from '../../game/rules/stage';

/** Sends a seated player everything private they're owed in this game, from
 * GameState. One-shot results are all here too: a phone that was away when
 * one went out would otherwise never learn it. Answers whether there was a
 * game with this player in it. */
export async function replayGameInfo(code: string, sessionId: string): Promise<boolean> {
	const state = await loadGameState(code);
	if (!state) return false;
	const player = Object.values(state.players).find((p) => p.sessionId === sessionId);
	if (!player) return false;

	// Everyone is sent their card at the start, whether or not they tapped
	// to view it during seating.
	emitToSession(sessionId, { kind: 'YourRole', role: player.role });

	if (state.lovers?.includes(player.seat)) {
		const [a, b] = state.lovers;
		emitToSession(sessionId, {
			kind: 'CoupleRevealed',
			partnerSeat: a === player.seat ? b : a,
			replay: true
		});
	}

	for (const check of state.seerChecks ?? []) {
		if (check.seat !== player.seat) continue;
		emitToSession(sessionId, {
			kind: 'SeerResult',
			targetSeat: check.targetSeat,
			isWolf: check.isBad,
			replay: true,
			nightNumber: check.round
		});
	}

	const canShoot = state.shotStatuses?.[player.seat];
	if (canShoot !== undefined) {
		emitToSession(sessionId, { kind: 'ShotStatus', canShoot, replay: true });
	}

	await replayTurnPrompt(code, state, player);
	return true;
}

async function replayTurnPrompt(code: string, state: GameState, player: Player): Promise<void> {
	if (!isNightPhase(state) || player.isDead) return;
	const stageRole = currentStageRole(state);
	if (!stageRole) return;

	// Already acted this turn - re-showing an unsubmitted form would only
	// invite a resubmission the engine rejects with 'already_submitted'.
	if (turnUsed(state, stageRole)) return;

	const effects = notifyRoleHolders(state, stageRole)
		.filter((e) => e.seat === player.seat)
		.map((e) =>
			e.payload.kind === 'YourTurnPrompt' ? { ...e, payload: { ...e.payload, replay: true } } : e
		);
	if (effects.length === 0) return;
	await translateEffects(code, effects);
	// A 开枪状态 prompt this seat has confirmed goes back to its waiting line.
	if (state.stageConfirms?.includes(player.seat)) {
		emitToSession(player.sessionId, { kind: 'StageConfirmed' });
	}
}
