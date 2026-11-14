import { describe, it, expect } from 'vitest';
import { defaultRuleConfig } from './defaultRuleConfig';
import { switchesOf } from './ruleSwitchValues';
import {
	RuleSwitchesSchema,
	mergeRuleConfig,
	RuleConfigOverridesSchema,
	type RuleSwitches,
	type MatchesRuleConfig
} from './ruleSwitches';
import type { RuleConfig } from './types';

describe('rule switches', () => {
	it('every switch is a RuleConfig field of the same type (compile-time)', () => {
		const switches = switchesOf(defaultRuleConfig());
		// Fails `npm run check` if a switch drifts from RuleConfig.
		const typed: MatchesRuleConfig<RuleSwitches, RuleConfig> = switches;
		expect(typed).toBe(switches);
	});

	it('the phone’s zod-free read gives exactly what the schema keeps', () => {
		const base = defaultRuleConfig();
		expect(switchesOf(base)).toEqual(RuleSwitchesSchema.parse(base));
	});

	it('reads exactly the switches out of a full RuleConfig', () => {
		const s = switchesOf(defaultRuleConfig());
		expect(Object.keys(s).sort()).toEqual(
			[
				'cupidPoisonBlocksHunter',
				'guard',
				'hunter',
				'idiot',
				'inAppVote',
				'winCondition',
				'witch',
				'wildChild',
				'wolf'
			].sort()
		);
		expect(s.wolf).toEqual({ allowEmptyKill: true, blackWolfKingCanShootWhenLoverSuicide: false });
		expect(s.cupidPoisonBlocksHunter).toBe(false);
		expect(s.wildChild).toEqual({ joinsPack: false });
		expect(s.inAppVote).toBe(false);
	});

	it('merging the defaults’ own switches changes nothing', () => {
		const base = defaultRuleConfig();
		expect(mergeRuleConfig(base, switchesOf(base))).toEqual(base);
	});

	it('merges top-level and grouped overrides, leaving the rest of each group', () => {
		const base = defaultRuleConfig();
		const merged = mergeRuleConfig(base, {
			winCondition: 'TOTAL_KILL',
			cupidPoisonBlocksHunter: true,
			witch: { selfRescue: 'ALWAYS' }
		});
		expect(merged.winCondition).toBe('TOTAL_KILL');
		expect(merged.cupidPoisonBlocksHunter).toBe(true);
		expect(merged.witch).toEqual({ ...base.witch, selfRescue: 'ALWAYS' });
		expect(merged.wolf).toEqual(base.wolf);
		expect(base.witch.selfRescue).toBe('FIRST_NIGHT_ONLY');
	});

	it('the wire schema accepts a partial set and drops unknown switches', () => {
		const parsed = RuleConfigOverridesSchema.parse({
			hunter: { canShootWhenPoisoned: true },
			sheriffEnabled: false
		});
		expect(parsed).toEqual({ hunter: { canShootWhenPoisoned: true } });
	});
});
