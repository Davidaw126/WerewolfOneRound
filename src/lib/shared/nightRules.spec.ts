import { describe, it, expect } from 'vitest';
import {
	hunterCanShoot,
	validateGuardAction,
	validateWitchAction,
	type WitchRuleState
} from './nightRules';
import type { Role } from './roles';

const identities: Record<string, Role> = {
	'1': '猎人',
	'2': '女巫',
	'3': '普通狼人',
	'4': '普通村民'
};

describe('hunterCanShoot', () => {
	it('no poison used at all -> can shoot', () => {
		expect(hunterCanShoot(identities, null, null, false)).toBe(true);
	});

	it('someone else was poisoned -> can still shoot', () => {
		expect(hunterCanShoot(identities, 4, null, false)).toBe(true);
	});

	it('the hunter themself was poisoned -> denied', () => {
		expect(hunterCanShoot(identities, 1, null, false)).toBe(false);
	});

	it('no hunter in the game -> vacuously true', () => {
		expect(hunterCanShoot({ '2': '女巫' }, 2, null, false)).toBe(true);
	});

	it('partner poisoned + cupidPoisonBlocksHunter on -> denied (殉情 house rule)', () => {
		expect(hunterCanShoot(identities, 4, [1, 4], true)).toBe(false);
	});

	it('partner poisoned but the house rule is off -> can shoot', () => {
		expect(hunterCanShoot(identities, 4, [1, 4], false)).toBe(true);
	});

	it('house rule on but the hunter is not in the couple -> can shoot', () => {
		expect(hunterCanShoot(identities, 4, [2, 4], true)).toBe(true);
	});
});

describe('validateWitchAction', () => {
	const base: WitchRuleState = {
		witchSeat: 2,
		killedSeat: 3,
		usedAntidote: false,
		usedPoison: false
	};

	it('doing nothing is always allowed', () => {
		expect(validateWitchAction({ useAntidote: false, poisonTarget: null }, base)).toBeNull();
	});

	it('saving a killed player is allowed', () => {
		expect(validateWitchAction({ useAntidote: true, poisonTarget: null }, base)).toBeNull();
	});

	it('poisoning alone is allowed', () => {
		expect(validateWitchAction({ useAntidote: false, poisonTarget: 4 }, base)).toBeNull();
	});

	it('rejects a spent antidote', () => {
		expect(
			validateWitchAction(
				{ useAntidote: true, poisonTarget: null },
				{ ...base, usedAntidote: true }
			)
		).toBe('antidote_spent');
	});

	it('rejects spent poison', () => {
		expect(
			validateWitchAction({ useAntidote: false, poisonTarget: 4 }, { ...base, usedPoison: true })
		).toBe('poison_spent');
	});

	it('rejects both potions in the same night', () => {
		expect(validateWitchAction({ useAntidote: true, poisonTarget: 4 }, base)).toBe(
			'witch_one_potion_per_night'
		);
	});

	it('rejects an antidote when nobody was attacked', () => {
		expect(
			validateWitchAction({ useAntidote: true, poisonTarget: null }, { ...base, killedSeat: null })
		).toBe('no_kill_to_save');
	});

	it('rejects self-save', () => {
		expect(
			validateWitchAction({ useAntidote: true, poisonTarget: null }, { ...base, killedSeat: 2 })
		).toBe('witch_no_self_save');
	});

	it('a spent potion is reported ahead of the situational rules', () => {
		// Both "already used" and "self save" apply; the player should be told
		// the potion is gone, since that's the more fundamental reason.
		expect(
			validateWitchAction(
				{ useAntidote: true, poisonTarget: null },
				{ ...base, killedSeat: 2, usedAntidote: true }
			)
		).toBe('antidote_spent');
	});

	it('poisoning the seat that was attacked is allowed (not a self-save)', () => {
		expect(validateWitchAction({ useAntidote: false, poisonTarget: 2 }, base)).toBeNull();
	});
});

describe('validateGuardAction', () => {
	it('allows any target on the first night', () => {
		expect(validateGuardAction(3, null)).toBeNull();
	});

	it('allows a different target than last night', () => {
		expect(validateGuardAction(3, 4)).toBeNull();
	});

	it('rejects the same target two nights running', () => {
		expect(validateGuardAction(3, 3)).toBe('guard_repeat_target');
	});
});
