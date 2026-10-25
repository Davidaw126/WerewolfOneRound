// Re-delivers a night-turn prompt that a client may have missed.
//
// YourTurnPrompt is a one-shot private emit, sent the instant a stage
// begins. A phone whose socket was down at that moment - iOS Safari drops
// the WebSocket within seconds of the screen locking or the tab going to the
// background, which is exactly what happens to a phone lying face-down
// during the night - never receives it, and nothing ever sent it again: the
// player's action panel simply never appeared for the rest of that turn.
// RoomJoin (full reload) and ResyncRequest (socket reconnect) both call this
// so a returning client gets its prompt back.
//
// Same SECURITY invariant as turnContext.ts: everything built here goes only
// to the one session that holds the seat, via translateEffects' PRIVATE path.

import { loadGameState } from './gameStateRepo';
import { translateEffects } from './effectTranslator';
import { notifyRoleHolders } from '../../game/rules/turnContext';
import type { RoleId } from '../../game/types';
import { PACK_KILL_ROLES } from '../../game/roleMeta';

export async function replayTurnPromptIfAny(code: string, sessionId: string): Promise<void> {
	const state = await loadGameState(code);
	// Night 1 is its own engine phase (FIRST_NIGHT), every later night is NIGHT.
	if (!state || (state.phase !== 'NIGHT' && state.phase !== 'FIRST_NIGHT')) return;

	const key = state.currentStepKey;
	if (!key || !key.startsWith('role:')) return;
	const stageRole = key.slice('role:'.length) as RoleId;

	const player = Object.values(state.players).find((p) => p.sessionId === sessionId);
	if (!player || player.isDead) return;

	// Already acted this turn - re-showing an unsubmitted form would only
	// invite a resubmission the engine rejects with 'already_submitted'. The
	// wolf kill is collective (WEREWOLF and WOLF_KING share one decision).
	const submitted = state.submittedRoles;
	if (stageRole === 'WEREWOLF') {
		if (submitted.some((r) => PACK_KILL_ROLES.has(r))) return; // recorded as 'WEREWOLF'
	} else if (submitted.includes(stageRole)) {
		return;
	}

	const effects = notifyRoleHolders(state, stageRole)
		.filter((e) => e.seat === player.seat)
		.map((e) => {
			const payload = e.payload as { kind?: string };
			return payload.kind === 'YourTurnPrompt'
				? { ...e, payload: { ...payload, replay: true } }
				: e;
		});
	if (effects.length === 0) return;
	await translateEffects(code, effects);
}
