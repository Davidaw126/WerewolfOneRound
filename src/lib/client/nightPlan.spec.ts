// The Host's strip of tonight's turns, from the board alone.
import { describe, it, expect } from 'vitest';
import { nightPlan } from './nightPlan';

const board = { WEREWOLF: 4, SEER: 1, WITCH: 1, HUNTER: 1, GUARD: 1, CUPID: 1, VILLAGER: 3 };
const labels = (steps: ReturnType<typeof nightPlan>) =>
	steps.map((s) => `${s.stage.kind === 'ROLE_TURN' ? s.stage.role : 'COUPLE'}:${s.status}`);

describe('the Host’s night plan', () => {
	it('night 1 includes 丘比特 and 情侣相认, marked up to the current turn', () => {
		const steps = nightPlan(board, 1, { kind: 'ROLE_TURN', role: 'GUARD' });
		const l = labels(steps);
		expect(l[0]).toBe('CUPID:done');
		expect(l[1]).toBe('COUPLE:done');
		expect(l).toContain('GUARD:now');
		expect(l.at(-1)).toMatch(/:next$/);
	});

	it('later nights drop the first-night turns', () => {
		const l = labels(nightPlan(board, 2, { kind: 'ROLE_TURN', role: 'WEREWOLF' }));
		expect(l.some((s) => s.startsWith('CUPID') || s.startsWith('COUPLE'))).toBe(false);
	});

	it('with no current stage, every turn is done', () => {
		expect(nightPlan(board, 2, null).every((s) => s.status === 'done')).toBe(true);
	});

	it('a board with no 预言家 never lists one', () => {
		const l = labels(nightPlan({ WEREWOLF: 2, VILLAGER: 3, WITCH: 1 }, 1, null));
		expect(l.some((s) => s.startsWith('SEER'))).toBe(false);
	});
});
