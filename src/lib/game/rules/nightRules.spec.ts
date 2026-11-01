import { describe, it, expect } from 'vitest';
import {
	validateWitchAction,
	validateGuardAction,
	validateSeerAction,
	validateWolfKillAction,
	type WitchRuleState
} from './nightRules';
import { defaultRuleConfig } from '../testFixtures';
import type { RuleConfig } from '../types';

const cfg = defaultRuleConfig();

describe('validateWitchAction', () => {
	const base: WitchRuleState = {
		witchSeat: 2,
		killedSeat: 3,
		usedAntidote: false,
		usedPoison: false,
		isFirstNight: true
	};

	it('doing nothing is always allowed', () => {
		expect(validateWitchAction(cfg, { useAntidote: false, poisonTarget: null }, base)).toBeNull();
	});

	it('saving a killed player is allowed', () => {
		expect(validateWitchAction(cfg, { useAntidote: true, poisonTarget: null }, base)).toBeNull();
	});

	it('poisoning alone is allowed', () => {
		expect(validateWitchAction(cfg, { useAntidote: false, poisonTarget: 4 }, base)).toBeNull();
	});

	it('rejects a spent antidote', () => {
		expect(
			validateWitchAction(
				cfg,
				{ useAntidote: true, poisonTarget: null },
				{ ...base, usedAntidote: true }
			)
		).toBe('antidote_spent');
	});

	it('rejects spent poison', () => {
		expect(
			validateWitchAction(
				cfg,
				{ useAntidote: false, poisonTarget: 4 },
				{ ...base, usedPoison: true }
			)
		).toBe('poison_spent');
	});

	it('rejects both potions in the same night (bothPotionsSameNight default false)', () => {
		expect(validateWitchAction(cfg, { useAntidote: true, poisonTarget: 4 }, base)).toBe(
			'witch_one_potion_per_night'
		);
	});

	it('bothPotionsSameNight = true house rule allows both at once', () => {
		const houseCfg: RuleConfig = { ...cfg, witch: { ...cfg.witch, bothPotionsSameNight: true } };
		expect(validateWitchAction(houseCfg, { useAntidote: true, poisonTarget: 4 }, base)).toBeNull();
	});

	it('rejects an antidote when nobody was attacked', () => {
		expect(
			validateWitchAction(
				cfg,
				{ useAntidote: true, poisonTarget: null },
				{ ...base, killedSeat: null }
			)
		).toBe('no_kill_to_save');
	});

	it('spec default (FIRST_NIGHT_ONLY): self-save allowed on the first night', () => {
		expect(
			validateWitchAction(
				cfg,
				{ useAntidote: true, poisonTarget: null },
				{ ...base, killedSeat: 2, isFirstNight: true }
			)
		).toBeNull();
	});

	it('spec default (FIRST_NIGHT_ONLY): self-save denied on a later night', () => {
		expect(
			validateWitchAction(
				cfg,
				{ useAntidote: true, poisonTarget: null },
				{ ...base, killedSeat: 2, isFirstNight: false }
			)
		).toBe('witch_no_self_save');
	});

	it('selfRescue = NEVER denies self-save even on the first night', () => {
		const houseCfg: RuleConfig = { ...cfg, witch: { ...cfg.witch, selfRescue: 'NEVER' } };
		expect(
			validateWitchAction(
				houseCfg,
				{ useAntidote: true, poisonTarget: null },
				{ ...base, killedSeat: 2, isFirstNight: true }
			)
		).toBe('witch_no_self_save');
	});

	it('selfRescue = ALWAYS allows self-save on any night', () => {
		const houseCfg: RuleConfig = { ...cfg, witch: { ...cfg.witch, selfRescue: 'ALWAYS' } };
		expect(
			validateWitchAction(
				houseCfg,
				{ useAntidote: true, poisonTarget: null },
				{ ...base, killedSeat: 2, isFirstNight: false }
			)
		).toBeNull();
	});

	it('a spent potion is reported ahead of the situational rules', () => {
		expect(
			validateWitchAction(
				cfg,
				{ useAntidote: true, poisonTarget: null },
				{ ...base, killedSeat: 2, usedAntidote: true, isFirstNight: false }
			)
		).toBe('antidote_spent');
	});

	it("today's default (canPoisonSelf = true): poisoning yourself is allowed", () => {
		expect(validateWitchAction(cfg, { useAntidote: false, poisonTarget: 2 }, base)).toBeNull();
	});

	it('canPoisonSelf = false house rule rejects self-poison', () => {
		const houseCfg: RuleConfig = { ...cfg, witch: { ...cfg.witch, canPoisonSelf: false } };
		expect(validateWitchAction(houseCfg, { useAntidote: false, poisonTarget: 2 }, base)).toBe(
			'witch_no_self_poison'
		);
	});
});

describe('validateGuardAction', () => {
	it('allows any target on the first night (no last-protected seat yet)', () => {
		expect(validateGuardAction(cfg, 3, 7, null)).toBeNull();
	});

	it('allows a different target than last night', () => {
		expect(validateGuardAction(cfg, 3, 7, 4)).toBeNull();
	});

	it('rejects the same target two nights running by default', () => {
		expect(validateGuardAction(cfg, 3, 7, 3)).toBe('guard_repeat_target');
	});

	it('canGuardSameTargetConsecutively = true house rule allows a repeat', () => {
		const houseCfg: RuleConfig = {
			...cfg,
			guard: { ...cfg.guard, canGuardSameTargetConsecutively: true }
		};
		expect(validateGuardAction(houseCfg, 3, 7, 3)).toBeNull();
	});

	it('空守 (no target) is refused by default and accepted when the room allows it', () => {
		expect(validateGuardAction(cfg, null, 7, 3)).toBe('guard_empty_not_allowed');
		const houseCfg: RuleConfig = { ...cfg, guard: { ...cfg.guard, allowEmptyGuard: true } };
		expect(validateGuardAction(houseCfg, null, 7, 3)).toBeNull();
	});

	it("today's default (canGuardSelf = true): guarding yourself is allowed", () => {
		expect(validateGuardAction(cfg, 7, 7, null)).toBeNull();
	});

	it('canGuardSelf = false house rule rejects self-guard', () => {
		const houseCfg: RuleConfig = { ...cfg, guard: { ...cfg.guard, canGuardSelf: false } };
		expect(validateGuardAction(houseCfg, 7, 7, null)).toBe('guard_no_self_guard');
	});
});

describe('validateSeerAction', () => {
	it("today's default (canCheckSelf = true): checking yourself is allowed", () => {
		expect(validateSeerAction(cfg, 5, 5)).toBeNull();
	});

	it('canCheckSelf = false house rule rejects self-check', () => {
		const houseCfg: RuleConfig = { ...cfg, seer: { ...cfg.seer, canCheckSelf: false } };
		expect(validateSeerAction(houseCfg, 5, 5)).toBe('seer_no_self_check');
	});

	it('checking another seat is always allowed', () => {
		expect(validateSeerAction(cfg, 5, 6)).toBeNull();
	});
});

describe('validateWolfKillAction', () => {
	it('a real target is always allowed', () => {
		expect(validateWolfKillAction(cfg, 3)).toBeNull();
	});

	it("today's default (allowEmptyKill = true): 空刀 (null target) is allowed", () => {
		expect(validateWolfKillAction(cfg, null)).toBeNull();
	});

	it('allowEmptyKill = false house rule rejects an empty kill', () => {
		const houseCfg: RuleConfig = { ...cfg, wolf: { ...cfg.wolf, allowEmptyKill: false } };
		expect(validateWolfKillAction(houseCfg, null)).toBe('wolf_empty_kill_not_allowed');
	});
});
