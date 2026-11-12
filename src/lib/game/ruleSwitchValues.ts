// The rule switches' values, read out of a RuleConfig - for the phone (the
// config panel), which must not ship zod. The switches themselves are
// defined in ruleSwitches.ts; SWITCH_KEYS below is typed from that schema,
// so it can't list a switch the schema lacks or miss one it has.

import type { RuleConfig } from './types';
import type { RuleSwitches } from './ruleSwitches';

type KeysOf<T> = {
	[K in keyof T]-?: T[K] extends Record<string, unknown> ? { [F in keyof T[K]]-?: true } : true;
};

const SWITCH_KEYS: KeysOf<RuleSwitches> = {
	winCondition: true,
	cupidPoisonBlocksHunter: true,
	wolf: { allowEmptyKill: true, blackWolfKingCanShootWhenLoverSuicide: true },
	guard: { sameGuardSameSave: true, allowEmptyGuard: true },
	witch: { selfRescue: true, canPoisonSelf: true, bothPotionsSameNight: true },
	hunter: {
		canShootWhenPoisoned: true,
		canShootWhenExiled: true,
		canShootWhenWolfKilled: true,
		canShootWhenLoverSuicide: true
	},
	idiot: {
		revealOnExile: true,
		keepsSpeechRight: true,
		losesVoteRight: true,
		canRunForSheriffAfterReveal: true,
		tearsBadgeIfSheriff: true,
		diesNormallyAtNight: true
	},
	wildChild: { joinsPack: true }
};

/** The switches' current values in a full RuleConfig - the panel starts
 * from the defaults' ones. */
export function switchesOf(config: RuleConfig): RuleSwitches {
	const source = config as unknown as Record<string, Record<string, unknown>>;
	const out: Record<string, unknown> = {};
	for (const [key, fields] of Object.entries(SWITCH_KEYS)) {
		out[key] =
			fields === true
				? source[key]
				: Object.fromEntries(Object.keys(fields).map((f) => [f, source[key][f]]));
	}
	return out as RuleSwitches;
}
