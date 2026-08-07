// Pure, RuleConfig-driven SUBMISSION-time gates ("may this action be sent at
// all") - a different concern from nightResolution.ts ("given the actions
// that were sent, who dies"). Ported from the old shared/nightRules.ts,
// keeping that file's own separation of concerns intact.
//
// The old hunterCanShoot() (a live-prediction helper for the 👍/👎 status
// indicator shown during the hunter's own turn) is ported to
// predictHunterCanShoot() in nightResolution.ts, next to canTriggerShoot and
// getLoverPartner - it can't just call canTriggerShoot with a hypothetical
// Death, because the cupidPoisonBlocksHunter check depends on the partner's
// ALREADY-RESOLVED deathCause, which doesn't exist yet at prediction time
// (nobody has died - this runs during the hunter's own live turn).

import type { RuleConfig, Seat } from '../types';

export type NightRuleError =
	| 'antidote_spent'
	| 'poison_spent'
	| 'witch_no_self_save'
	| 'witch_no_self_poison'
	| 'witch_one_potion_per_night'
	| 'no_kill_to_save'
	| 'guard_repeat_target'
	| 'guard_no_self_guard'
	| 'seer_no_self_check'
	| 'wolf_empty_kill_not_allowed'
	| 'already_submitted'
	/** §4.2/B49 - 恶灵骑士 feared this seat last night; no skill use until the
	 * fear clears at the start of the next night. */
	| 'feared'
	/** §D thief.mustTakeWolfIfBothWolf (UT-24) - both buried cards are wolf
	 * roles, so "keep original identity" isn't an option this time. */
	| 'thief_must_take_wolf';

export interface WitchRuleState {
	/** The acting witch's own seat, taken from the server-side seat lookup -
	 * never from the client payload. */
	witchSeat: Seat;
	/** Tonight's 普通狼人 target, re-read server-side from the night hash. */
	killedSeat: Seat | null;
	usedAntidote: boolean;
	usedPoison: boolean;
	isFirstNight: boolean;
}

/**
 * Order matters: the first failing check is the message the player sees, so
 * "you already used it" is reported ahead of the situational rules.
 */
export function validateWitchAction(
	cfg: RuleConfig,
	action: { useAntidote: boolean; poisonTarget: Seat | null },
	state: WitchRuleState
): NightRuleError | null {
	if (action.useAntidote && state.usedAntidote) return 'antidote_spent';
	if (action.poisonTarget !== null && state.usedPoison) return 'poison_spent';
	if (action.useAntidote && action.poisonTarget !== null && !cfg.witch.bothPotionsSameNight) {
		return 'witch_one_potion_per_night';
	}
	if (action.useAntidote && state.killedSeat === null) return 'no_kill_to_save';
	if (action.useAntidote && state.killedSeat === state.witchSeat) {
		const selfSaveAllowed =
			cfg.witch.selfRescue === 'ALWAYS' ||
			(cfg.witch.selfRescue === 'FIRST_NIGHT_ONLY' && state.isFirstNight);
		if (!selfSaveAllowed) return 'witch_no_self_save';
	}
	if (
		action.poisonTarget !== null &&
		action.poisonTarget === state.witchSeat &&
		!cfg.witch.canPoisonSelf
	) {
		return 'witch_no_self_poison';
	}
	return null;
}

/** The guard may not protect the same seat two nights running (unless the
 * house rule allows it), and may only self-guard if configured to. */
export function validateGuardAction(
	cfg: RuleConfig,
	targetSeat: Seat,
	guardSeat: Seat,
	lastProtectedSeat: Seat | null
): NightRuleError | null {
	if (!cfg.guard.canGuardSelf && targetSeat === guardSeat) return 'guard_no_self_guard';
	if (
		!cfg.guard.canGuardSameTargetConsecutively &&
		lastProtectedSeat !== null &&
		targetSeat === lastProtectedSeat
	) {
		return 'guard_repeat_target';
	}
	return null;
}

export function validateSeerAction(
	cfg: RuleConfig,
	targetSeat: Seat,
	seerSeat: Seat
): NightRuleError | null {
	if (!cfg.seer.canCheckSelf && targetSeat === seerSeat) return 'seer_no_self_check';
	return null;
}

/** null targetSeat means 空刀 (empty kill) - only valid if the house rule
 * allows it. */
export function validateWolfKillAction(
	cfg: RuleConfig,
	targetSeat: Seat | null
): NightRuleError | null {
	if (targetSeat === null && !cfg.wolf.allowEmptyKill) return 'wolf_empty_kill_not_allowed';
	return null;
}
