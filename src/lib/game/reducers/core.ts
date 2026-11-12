// Shared by every reducer: the immer + effects pattern, rule rejections,
// and ending the game. Part of the engine (see engine.ts) - pure, no IO.

import { produce } from 'immer';
import type { EngineEffect, EngineResult, GameState, RoleId, Seat, Camp } from '../types';
import { type NightRuleError } from '../rules/nightRules';
import { revealedCard } from '../rules/winCondition';

// ---------------------------------------------------------------------------
// withEffects - the immer + side-channel-effects-array pattern every reducer
// is built on. Effects are plain descriptions (§2.1.2), never actual
// socket emits - only the IO shell turns them into real I/O.
// ---------------------------------------------------------------------------

export function withEffects(
	state: GameState,
	recipe: (draft: GameState, effects: EngineEffect[]) => void
): EngineResult {
	const effects: EngineEffect[] = [];
	const newState = produce(state, (draft) => {
		recipe(draft as GameState, effects);
	});
	return { state: newState, effects };
}

export function reject(effects: EngineEffect[], seat: Seat, error: NightRuleError): void {
	effects.push({ kind: 'PRIVATE', seat, payload: { kind: 'NightActionRejected', error } });
}

export function endGame(draft: GameState, effects: EngineEffect[], winner: Camp): void {
	draft.phase = 'GAME_OVER';
	draft.winner = winner;
	const identities: Record<Seat, RoleId> = {};
	for (const p of Object.values(draft.players)) identities[p.seat] = revealedCard(p);
	// Immer revokes every draft proxy once produce() returns - `effects` lives
	// outside the draft tree, so any array/object read off `draft` must be
	// copied into a plain value before it's embedded in a payload, or it
	// becomes a "revoked proxy" the instant this producer call finishes. A
	// shallow spread is enough here since the tuple only ever holds primitive
	// seat numbers.
	const coupleSeats: [Seat, Seat] | null = draft.lovers ? [draft.lovers[0], draft.lovers[1]] : null;
	effects.push({
		kind: 'BROADCAST',
		payload: { kind: 'GameOver', winner, identities, coupleSeats }
	});
}
