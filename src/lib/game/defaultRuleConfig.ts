// The production default RuleConfig (§6) - every field at the value
// documented inline on RuleConfig itself in types.ts, which is the source of
// truth for *why* each default was chosen. Every game starts from exactly
// this snapshot, then M2's host-facing overrides (mergeRuleConfig below) lay
// on top of it.

import type { RuleConfig } from './types';

/** The M2-exposed subset of RuleConfig a host can override on the room-config
 * screen (winCondition + wolf/guard/witch/hunter/idiot groups) - independently
 * declared here rather than imported from shared/events.ts's Zod schema, so
 * the dependency runs shared -> game (the wire protocol describes engine
 * data), never the other way. Every field optional: absent = keep the
 * default. */
export interface RuleConfigOverrides {
	winCondition?: RuleConfig['winCondition'];
	wolf?: Partial<Pick<RuleConfig['wolf'], 'allowEmptyKill'>>;
	guard?: Partial<Pick<RuleConfig['guard'], 'sameGuardSameSave'>>;
	witch?: Partial<
		Pick<RuleConfig['witch'], 'selfRescue' | 'canPoisonSelf' | 'bothPotionsSameNight'>
	>;
	hunter?: Partial<RuleConfig['hunter']>;
	idiot?: Partial<RuleConfig['idiot']>;
}

export function mergeRuleConfig(base: RuleConfig, overrides?: RuleConfigOverrides): RuleConfig {
	if (!overrides) return base;
	return {
		...base,
		winCondition: overrides.winCondition ?? base.winCondition,
		wolf: { ...base.wolf, ...overrides.wolf },
		guard: { ...base.guard, ...overrides.guard },
		witch: { ...base.witch, ...overrides.witch },
		hunter: { ...base.hunter, ...overrides.hunter },
		idiot: { ...base.idiot, ...overrides.idiot }
	};
}

export function defaultRuleConfig(): RuleConfig {
	return {
		winCondition: 'SIDE_KILL',
		loversWinOverridesCamp: true,
		cupidJoinsLoversCamp: true,
		cupidWinsIfDead: true,

		sheriffEnabled: true,
		sheriffVoteWeight: 1.5,
		sheriffDecidesSpeechOrder: true,
		sheriffBadgeOnDeath: 'TRANSFER_OR_TEAR',
		tieBreak: 'PK_THEN_NO_EXILE',
		allowAbstain: true,
		sheriffMustVote: true,
		lastWords: {
			firstNightVictim: true,
			exiledPlayer: true,
			hunterShotVictim: true,
			nightVictimAfterFirst: false
		},
		announceDeathBeforeSheriff: false,

		stepTimeoutSec: 30,
		timeoutBehavior: 'SKIP',

		wolf: {
			allowEmptyKill: true,
			decisionRule: 'HOST_DECIDES',
			allowSelfExplode: true,
			selfExplodeEndsDay: true,
			selfExplodeHasLastWords: false,
			wolfKingExplodeCanShoot: true
		},
		seer: {
			canCheckSelf: true,
			allowRecheck: true,
			resultGranularity: 'GOOD_BAD'
		},
		witch: {
			knowsVictimOnFirstNight: true,
			knowsVictimEveryNight: true,
			selfRescue: 'FIRST_NIGHT_ONLY',
			bothPotionsSameNight: false,
			canPoisonSelf: true,
			mustOpenEyesWhenEmpty: true
		},
		guard: {
			canGuardSameTargetConsecutively: false,
			canGuardSelf: true,
			sameGuardSameSave: 'TARGET_DIES',
			protectsAgainstPoison: false
		},
		hunter: {
			canShootWhenPoisoned: false,
			canShootWhenExiled: true,
			canShootWhenWolfKilled: true,
			canShootWhenLoverSuicide: true
		},
		idiot: {
			revealOnExile: true,
			keepsSpeechRight: true,
			losesVoteRight: true,
			canRunForSheriffAfterReveal: false,
			tearsBadgeIfSheriff: true,
			diesNormallyAtNight: true
		},
		knight: {
			duelEndsDayIfWolf: true,
			knightDiesIfGood: true,
			onceOnly: true
		},
		cupid: {
			canLinkSelf: true,
			loversSeeEachOtherRole: true,
			suicideTriggersHunter: false
		},
		thief: {
			mustTakeWolfIfBothWolf: true
		},
		wildChild: {
			wolvesSeeConvertedChild: true,
			childSeesWolvesAfterConvert: true
		},

		cupidPoisonBlocksHunter: false,
		deadSeeAllRoles: true
	};
}
