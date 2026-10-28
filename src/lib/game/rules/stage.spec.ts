import { describe, it, expect } from 'vitest';
import { makeState } from '../testFixtures';
import {
	stageKey,
	stageOfKey,
	currentStageRole,
	roleHasLivingHolder,
	turnUsed,
	stageConfirmComplete,
	stageFinished
} from './stage';

const board = { 1: 'WEREWOLF', 2: 'WOLF_KING', 3: 'SEER', 4: 'HUNTER', 5: 'VILLAGER' } as const;

describe('the step key', () => {
	it('round-trips both kinds of stage', () => {
		for (const stage of [{ kind: 'ROLE_TURN', role: 'SEER' }, { kind: 'COUPLE_REVEAL' }] as const) {
			expect(stageOfKey(stageKey(stage))).toEqual(stage);
		}
		expect(stageOfKey(null)).toBeNull();
	});
});

describe('who holds a turn', () => {
	it('a lone surviving wolf king still holds the pack turn', () => {
		const state = makeState({ ...board });
		state.players[1].isDead = true;
		expect(roleHasLivingHolder(state, 'WEREWOLF')).toBe(true);
		state.players[2].isDead = true;
		expect(roleHasLivingHolder(state, 'WEREWOLF')).toBe(false);
	});
});

describe('is the turn done', () => {
	it('the pack kill counts once, whichever wolf made it', () => {
		const state = makeState(
			{ ...board },
			{ currentStepKey: stageKey({ kind: 'ROLE_TURN', role: 'WEREWOLF' }) }
		);
		expect(turnUsed(state, 'WEREWOLF')).toBe(false);
		state.submittedRoles = ['WOLF_KING'];
		expect(turnUsed(state, 'WEREWOLF')).toBe(true);
		expect(stageFinished(state)).toBe(true);
	});

	it('a status stage is done only when every living holder has confirmed', () => {
		const state = makeState({ ...board, 6: 'HUNTER' }, { currentStepKey: 'role:HUNTER' });
		expect(currentStageRole(state)).toBe('HUNTER');
		state.stageConfirms = [4];
		expect(stageConfirmComplete(state)).toBe(false);
		state.stageConfirms = [4, 6];
		expect(stageFinished(state)).toBe(true);
	});

	it('情侣相认 waits for every living lover', () => {
		const state = makeState({ ...board }, { currentStepKey: 'couple_reveal', lovers: [3, 5] });
		expect(currentStageRole(state)).toBeNull();
		state.stageConfirms = [3];
		expect(stageFinished(state)).toBe(false);
		state.players[5].isDead = true;
		expect(stageFinished(state)).toBe(true);
	});
});
