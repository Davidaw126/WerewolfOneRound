import { describe, it, expect } from 'vitest';
import { ALL_ROLE_IDS, ROLE_META, PACK_MEMBER_ROLES } from '$lib/game/roleMeta';
import { zh } from '$lib/shared/i18n/zh';
import { narrationFor, promptFor, selectLabelFor, statusLabelFor } from './roleNight';

const withOwnTurn = ALL_ROLE_IDS.filter((r) => ROLE_META[r].implemented && ROLE_META[r].nightTurn);

describe('every role with a night turn is fully described', () => {
	it.each(withOwnTurn)('%s has a narration line that exists', (role) => {
		const key = narrationFor(role);
		expect(key).not.toBeNull();
		expect(zh.narration[key!]).toBeTruthy();
	});

	it.each(withOwnTurn.filter((r) => ROLE_META[r].nightTurn === 'pick'))(
		'%s asks the player to choose',
		(role) => {
			const key = selectLabelFor(role, false);
			expect(key).not.toBeNull();
			expect(zh.nightPrompt[key!]).toBeTruthy();
		}
	);

	it.each(withOwnTurn.filter((r) => ROLE_META[r].nightTurn === 'status'))(
		'%s has its status wording',
		(role) => {
			expect(zh.nightPrompt[statusLabelFor(role)]).toBeTruthy();
		}
	);
});

describe('the prompt for a turn', () => {
	it("is a seat pick for every pack member in the pack's kill turn", () => {
		for (const role of PACK_MEMBER_ROLES) {
			expect(promptFor(role, true)).toBe('pick');
			expect(selectLabelFor(role, true)).toBe('selectWolfTarget');
		}
	});

	it("is the role's own turn otherwise", () => {
		expect(promptFor('BLACK_WOLF_KING', false)).toBe('status');
		expect(promptFor('WITCH', false)).toBe('potions');
		expect(promptFor('CUPID', false)).toBe('link');
		expect(promptFor('THIEF', false)).toBe('thief');
		expect(selectLabelFor('WOLF_BEAUTY', false)).toBe('selectWolfBeautyTarget');
	});
});
