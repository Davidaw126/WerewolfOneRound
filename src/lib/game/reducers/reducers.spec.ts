// Direct tests, through reduce(), for the reducers the full-flow engine
// specs only reached in passing: 确认 stages and the Host's DAY_OUT record.
import { describe, it, expect } from 'vitest';
import { reduce } from '../engine';
import { makeState } from '../testFixtures';

const board = {
	1: 'WEREWOLF',
	2: 'WEREWOLF',
	3: 'SEER',
	4: 'HUNTER',
	5: 'VILLAGER',
	6: 'VILLAGER'
} as const;
const kinds = (r: ReturnType<typeof reduce>) => r.effects.map((e) => e.payload.kind);

describe('CONFIRM_STAGE', () => {
	it('records the 猎人 confirming his own 开枪状态 stage, once', () => {
		const state = makeState({ ...board }, { phase: 'NIGHT', currentStepKey: 'role:HUNTER' });
		const first = reduce(state, { type: 'CONFIRM_STAGE', seat: 4 });
		expect(first.state.stageConfirms).toEqual([4]);
		expect(kinds(first)).toEqual(['StageConfirmed']);
		expect(reduce(first.state, { type: 'CONFIRM_STAGE', seat: 4 }).effects).toEqual([]);
	});

	it("ignores anyone else's tap, so every phone's button looks the same", () => {
		const state = makeState({ ...board }, { phase: 'NIGHT', currentStepKey: 'role:HUNTER' });
		const r = reduce(state, { type: 'CONFIRM_STAGE', seat: 5 });
		expect(r.effects).toEqual([]);
		expect(r.state.stageConfirms ?? []).toEqual([]);
	});

	it('on 情侣相认 counts only the living lovers', () => {
		const state = makeState(
			{ ...board },
			{ phase: 'NIGHT', currentStepKey: 'couple_reveal', lovers: [3, 5] }
		);
		expect(reduce(state, { type: 'CONFIRM_STAGE', seat: 6 }).effects).toEqual([]);
		expect(reduce(state, { type: 'CONFIRM_STAGE', seat: 3 }).state.stageConfirms).toEqual([3]);
	});

	it('does nothing outside the night', () => {
		const state = makeState({ ...board }, { phase: 'DISCUSSION', currentStepKey: 'role:HUNTER' });
		expect(reduce(state, { type: 'CONFIRM_STAGE', seat: 4 }).effects).toEqual([]);
	});
});

describe('DAY_OUT', () => {
	it('marks the seats out and tells the room, with any lover who follows', () => {
		const state = makeState({ ...board }, { phase: 'DISCUSSION', lovers: [5, 6] });
		const r = reduce(state, { type: 'DAY_OUT', seats: [5, 5] });
		expect(r.state.players[5].isDead).toBe(true);
		expect(r.state.players[6].isDead).toBe(true);
		expect(r.effects.find((e) => e.payload.kind === 'DayOut')?.payload).toEqual({
			kind: 'DayOut',
			seats: [5],
			followDeaths: [6]
		});
	});

	it('ignores seats already dead, and anything outside the discussion', () => {
		const dead = makeState({ ...board }, { phase: 'DISCUSSION' });
		dead.players[5].isDead = true;
		expect(reduce(dead, { type: 'DAY_OUT', seats: [5] }).effects).toEqual([]);
		const night = makeState({ ...board }, { phase: 'NIGHT' });
		expect(reduce(night, { type: 'DAY_OUT', seats: [5] }).effects).toEqual([]);
	});

	it('ends the game when the last wolf is marked out', () => {
		const state = makeState({ ...board }, { phase: 'DISCUSSION' });
		state.players[1].isDead = true;
		const r = reduce(state, { type: 'DAY_OUT', seats: [2] });
		expect(r.state.phase).toBe('GAME_OVER');
		expect(kinds(r)).toContain('GameOver');
	});
});
