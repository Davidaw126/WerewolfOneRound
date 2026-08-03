// Pure night-phase rule checks - no I/O, no Redis, no socket. Deliberately
// lives in `shared/` rather than `server/game/` so it stays unit-testable:
// anything under `server/` transitively imports `server/redis.ts`, which
// constructs a live Redis client at module scope.
//
// These are *submission-time* gates ("may this action be sent at all"), which
// is a different concern from nightResolution.ts ("given the actions that were
// sent, who dies"). Keep them apart - nightResolution.ts is a documented
// bit-for-bit port of the original resolver and shouldn't grow new rules.

import type { Role } from './roles';

/** Why a night action was rejected. Sent back as the socket ack's `error` and
 * mapped to a Chinese message client-side. */
export type NightRuleError =
	| 'antidote_spent'
	| 'poison_spent'
	| 'witch_no_self_save'
	| 'witch_one_potion_per_night'
	| 'no_kill_to_save'
	| 'guard_repeat_target'
	| 'already_submitted';

/**
 * Whether a hunter who dies tonight gets to fire. Poison is the only thing
 * that denies the shot - being guarded, charmed, or voted out all leave it
 * available.
 *
 * Called from two places that must never disagree: the live 👍/👎 indicator
 * shown on the hunter's own night turn (which runs after the witch's, so the
 * poison target is already known), and the actual authorization at night
 * resolution.
 */
export function hunterCanShoot(
	identities: Record<string, Role>,
	witchPoisonSeat: number | null,
	coupleSeats: [number, number] | null,
	cupidPoisonBlocksHunter: boolean
): boolean {
	if (witchPoisonSeat === null) return true;
	const hunterEntry = Object.entries(identities).find(([, r]) => r === '猎人');
	if (!hunterEntry) return true;
	const hunterSeat = Number(hunterEntry[0]);
	if (hunterSeat === witchPoisonSeat) return false;
	// House rule (host-configurable, default off): a hunter who dies via
	// Cupid follow-death (殉情) because their linked partner was poisoned is
	// also denied, same as being poisoned directly.
	if (cupidPoisonBlocksHunter && coupleSeats && coupleSeats.includes(hunterSeat)) {
		const partner = coupleSeats[0] === hunterSeat ? coupleSeats[1] : coupleSeats[0];
		if (partner === witchPoisonSeat) return false;
	}
	return true;
}

export interface WitchRuleState {
	/** The acting witch's own seat, taken from the server-side seat lookup -
	 * never from the client payload. */
	witchSeat: number;
	/** Tonight's 普通狼人 target, re-read server-side from the night hash. */
	killedSeat: number | null;
	usedAntidote: boolean;
	usedPoison: boolean;
}

/**
 * Order matters: the first failing check is the message the player sees, so
 * "you already used it" is reported ahead of the situational rules.
 */
export function validateWitchAction(
	action: { useAntidote: boolean; poisonTarget: number | null },
	state: WitchRuleState
): NightRuleError | null {
	if (action.useAntidote && state.usedAntidote) return 'antidote_spent';
	if (action.poisonTarget !== null && state.usedPoison) return 'poison_spent';
	if (action.useAntidote && action.poisonTarget !== null) return 'witch_one_potion_per_night';
	if (action.useAntidote && state.killedSeat === null) return 'no_kill_to_save';
	if (action.useAntidote && state.killedSeat === state.witchSeat) return 'witch_no_self_save';
	return null;
}

/** The guard may not protect the same seat two nights running. */
export function validateGuardAction(
	targetSeat: number,
	lastProtectedSeat: number | null
): NightRuleError | null {
	if (lastProtectedSeat !== null && targetSeat === lastProtectedSeat) return 'guard_repeat_target';
	return null;
}
