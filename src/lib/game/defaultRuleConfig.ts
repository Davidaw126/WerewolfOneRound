// The production default RuleConfig (§6) - every field at the value
// documented inline on RuleConfig itself in types.ts, which is the source of
// truth for *why* each default was chosen. Every game starts from exactly
// this snapshot, then the Host's rule switches (ruleSwitches.ts) lay on top
// of it.

import type { RuleConfig } from './types';

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
		// All off: last words happen at the table, and the app doesn't run a
		// speaker queue the host has to tap through (LAST_WORDS stays
		// supported for a rule set that turns these back on).
		lastWords: {
			firstNightVictim: false,
			exiledPlayer: false,
			hunterShotVictim: false,
			nightVictimAfterFirst: false
		},
		announceDeathBeforeSheriff: false,
		shotsAtTable: true,

		stepTimeoutSec: 30,
		timeoutBehavior: 'SKIP',

		wolf: {
			allowEmptyKill: true,
			decisionRule: 'HOST_DECIDES',
			allowSelfExplode: true,
			selfExplodeEndsDay: true,
			selfExplodeHasLastWords: false,
			wolfKingExplodeCanShoot: true,
			blackWolfKingCanShootWhenLoverSuicide: false
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
			allowEmptyGuard: false,
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
