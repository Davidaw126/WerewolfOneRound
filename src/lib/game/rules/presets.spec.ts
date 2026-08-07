import { describe, it, expect } from 'vitest';
import { PRESET_BOARDS } from './presets';
import { buildSetup, validateSetup } from './setup';

describe('PRESET_BOARDS', () => {
	it('has exactly the 7 fixed boards from spec §5.1 (自定义 is the UI default, not a data entry)', () => {
		expect(PRESET_BOARDS).toHaveLength(7);
	});

	it.each(PRESET_BOARDS.map((b) => [b.name, b] as const))(
		'%s: role total matches its stated player count and passes validateSetup clean',
		(_name, board) => {
			const setup = buildSetup(board.roleConfig);
			expect(setup.numberOfSeats).toBe(board.playerCount);
			const result = validateSetup(setup, board.playerCount);
			expect(result.errors).toEqual([]);
		}
	);
});
