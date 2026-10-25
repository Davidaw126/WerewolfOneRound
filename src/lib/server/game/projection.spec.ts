import { describe, it, expect } from 'vitest';
import { reduce } from '../../game/engine';
import { makeState } from '../../game/testFixtures';
import { deadSeatsOf } from './projection';

describe('deadSeatsOf', () => {
	it("keeps tonight's deaths secret until the host announces them", () => {
		let state = makeState(
			{ 1: 'WEREWOLF', 2: 'SEER', 3: 'VILLAGER', 4: 'VILLAGER', 5: 'WEREWOLF' },
			{ currentStepKey: 'role:WEREWOLF' }
		);
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 3 }
		}));
		while (state.phase !== 'DAWN') ({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));

		expect(state.players[3].isDead).toBe(true);
		expect(deadSeatsOf(state)).toEqual([]);

		({ state } = reduce(state, { type: 'ANNOUNCE_NIGHT_RESULTS' }));
		expect(deadSeatsOf(state)).toEqual([3]);
	});
});
