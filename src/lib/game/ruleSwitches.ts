// The Host's rule switches: the part of RuleConfig (§6) the room-config
// screen lets the Host change. Defined once, here, as a schema - the wire
// contract validates against it, the types come from it, the panel's state
// is one RuleSwitches value, and the room stores the overrides as-is. A new
// switch is one line here, its key in ruleSwitchValues.ts (a compile error
// until added) and its toggle on the panel.
//
// zod is plain data validation, nothing IO-bound, so the engine may own it -
// but the phone must not ship it: the panel reads the switches' values with
// ruleSwitchValues.ts, which only imports this file's types.

import { z } from 'zod';
import type { RuleConfig } from './types';

const GROUPS = {
	wolf: z.object({
		allowEmptyKill: z.boolean(),
		blackWolfKingCanShootWhenLoverSuicide: z.boolean()
	}),
	guard: z.object({
		sameGuardSameSave: z.enum(['TARGET_DIES', 'TARGET_LIVES']),
		allowEmptyGuard: z.boolean()
	}),
	witch: z.object({
		selfRescue: z.enum(['FIRST_NIGHT_ONLY', 'NEVER', 'ALWAYS']),
		canPoisonSelf: z.boolean(),
		bothPotionsSameNight: z.boolean()
	}),
	hunter: z.object({
		canShootWhenPoisoned: z.boolean(),
		canShootWhenExiled: z.boolean(),
		canShootWhenWolfKilled: z.boolean(),
		canShootWhenLoverSuicide: z.boolean()
	}),
	idiot: z.object({
		revealOnExile: z.boolean(),
		keepsSpeechRight: z.boolean(),
		losesVoteRight: z.boolean(),
		canRunForSheriffAfterReveal: z.boolean(),
		tearsBadgeIfSheriff: z.boolean(),
		diesNormallyAtNight: z.boolean()
	})
};

const TOP = {
	winCondition: z.enum(['SIDE_KILL', 'TOTAL_KILL']),
	/** A lover who dies of 殉情 after their partner was poisoned counts as
	 * poisoned too, for the 猎人's shot. */
	cupidPoisonBlocksHunter: z.boolean()
};

/** Every switch, each with a value - what the panel edits. */
export const RuleSwitchesSchema = z.object({ ...TOP, ...GROUPS });
export type RuleSwitches = z.infer<typeof RuleSwitchesSchema>;

/** What the room stores and the wire carries: any subset of the switches;
 * an absent one keeps the engine default. */
export const RuleConfigOverridesSchema = z
	.object({
		...TOP,
		wolf: GROUPS.wolf.partial(),
		guard: GROUPS.guard.partial(),
		witch: GROUPS.witch.partial(),
		hunter: GROUPS.hunter.partial(),
		idiot: GROUPS.idiot.partial()
	})
	.partial();
export type RuleConfigOverrides = z.infer<typeof RuleConfigOverridesSchema>;

/** Lays the Host's overrides onto `base`, group by group. */
export function mergeRuleConfig(base: RuleConfig, overrides?: RuleConfigOverrides): RuleConfig {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(overrides ?? {})) {
		if (value === undefined) continue;
		const current = merged[key];
		merged[key] =
			typeof value === 'object' && typeof current === 'object' ? { ...current, ...value } : value;
	}
	return merged as unknown as RuleConfig;
}

/** Type-level guard: every switch is a RuleConfig field of exactly the same
 * type. A switch missing from RuleConfig, or typed differently, maps to
 * `never` - see ruleSwitches.spec.ts, which assigns RuleSwitches to this. */
export type MatchesRuleConfig<S, C> = {
	[K in keyof S]: K extends keyof C
		? S[K] extends Record<string, unknown>
			? MatchesRuleConfig<S[K], C[K]>
			: [S[K]] extends [C[K]]
				? [C[K]] extends [S[K]]
					? S[K]
					: never
				: never
		: never;
};
