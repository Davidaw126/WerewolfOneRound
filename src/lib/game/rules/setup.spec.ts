import { describe, it, expect } from 'vitest';
import { buildSetup, validateSetup } from './setup';
import type { RoleId } from '../types';

function codesOf(result: ReturnType<typeof validateSetup>) {
	return result.errors.map((e) => e.code);
}

describe('buildSetup', () => {
	it('sums god-camp GOOD roles into godCount, VILLAGER into villagerCount', () => {
		const setup = buildSetup({ WEREWOLF: 2, SEER: 1, WITCH: 1, VILLAGER: 3 });
		expect(setup.godCount).toBe(2);
		expect(setup.villagerCount).toBe(3);
		expect(setup.numberOfSeats).toBe(7);
	});
});

describe('validateSetup', () => {
	const balanced: Partial<Record<RoleId, number>> = { WEREWOLF: 2, SEER: 1, WITCH: 1, VILLAGER: 4 };

	it('a well-formed 8-seat board with matching playerCount passes clean', () => {
		const setup = buildSetup(balanced);
		const result = validateSetup(setup, 8);
		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	it('E01: playerCount not matching numberOfSeats blocks (understaffed room)', () => {
		const setup = buildSetup(balanced);
		const result = validateSetup(setup, 6);
		expect(result.ok).toBe(false);
		expect(codesOf(result)).toContain('E01');
	});

	it('E02: zero wolves blocks', () => {
		const setup = buildSetup({ SEER: 1, WITCH: 1, VILLAGER: 4 });
		const result = validateSetup(setup, setup.numberOfSeats);
		expect(codesOf(result)).toContain('E02');
	});

	it('E03: zero good-camp players blocks', () => {
		const setup = buildSetup({ WEREWOLF: 3 });
		const result = validateSetup(setup, setup.numberOfSeats);
		expect(codesOf(result)).toContain('E03');
	});

	it('E04: wolves >= goods blocks (game would already be over)', () => {
		const setup = buildSetup({ WEREWOLF: 3, VILLAGER: 2 });
		const result = validateSetup(setup, setup.numberOfSeats);
		expect(codesOf(result)).toContain('E04');
	});

	it('E04: wolves one less than goods is fine', () => {
		const setup = buildSetup({ WEREWOLF: 2, VILLAGER: 3 });
		const result = validateSetup(setup, setup.numberOfSeats);
		expect(codesOf(result)).not.toContain('E04');
	});

	it('E05: a negative role count blocks', () => {
		const setup = buildSetup({ WEREWOLF: 2, VILLAGER: -1 });
		const result = validateSetup(setup, setup.numberOfSeats);
		expect(codesOf(result)).toContain('E05');
	});

	it('E05: more than one of a unique role (e.g. two witches) blocks', () => {
		const setup = buildSetup({ WEREWOLF: 2, WITCH: 2, VILLAGER: 3 });
		const result = validateSetup(setup, setup.numberOfSeats);
		expect(codesOf(result)).toContain('E05');
	});

	it('E05: VILLAGER and WEREWOLF are exempt from the uniqueness cap', () => {
		const setup = buildSetup({ WEREWOLF: 3, VILLAGER: 5 });
		const result = validateSetup(setup, setup.numberOfSeats);
		expect(codesOf(result)).not.toContain('E05');
	});

	it('E07: WILD_CHILD in play with fewer than 4 players blocks', () => {
		const setup = buildSetup({ WEREWOLF: 1, WILD_CHILD: 1, VILLAGER: 1 });
		const result = validateSetup(setup, setup.numberOfSeats);
		expect(codesOf(result)).toContain('E07');
	});

	it('E07: WILD_CHILD in play with >= 4 players is fine', () => {
		const setup = buildSetup({ WEREWOLF: 1, WILD_CHILD: 1, VILLAGER: 2 });
		const result = validateSetup(setup, setup.numberOfSeats);
		expect(codesOf(result)).not.toContain('E07');
	});

	it('E08: CUPID in play with fewer than 6 players blocks', () => {
		const setup = buildSetup({ WEREWOLF: 1, CUPID: 1, VILLAGER: 2 });
		const result = validateSetup(setup, setup.numberOfSeats);
		expect(codesOf(result)).toContain('E08');
	});

	it('E08: CUPID in play with >= 6 players is fine', () => {
		const setup = buildSetup({ WEREWOLF: 2, CUPID: 1, VILLAGER: 3 });
		const result = validateSetup(setup, setup.numberOfSeats);
		expect(codesOf(result)).not.toContain('E08');
	});

	it('E09: KNIGHT + IDIOT together is a non-blocking warning, not an error', () => {
		const setup = buildSetup({ WEREWOLF: 2, KNIGHT: 1, IDIOT: 1, VILLAGER: 3 });
		const result = validateSetup(setup, setup.numberOfSeats);
		expect(result.ok).toBe(true);
		expect(codesOf(result)).not.toContain('E09');
		expect(result.warnings.map((w) => w.code)).toContain('E09');
	});

	it('multiple violations all get reported together', () => {
		const setup = buildSetup({ SEER: 2 }); // no wolves, no other goods besides the (duplicated) seer
		const result = validateSetup(setup, setup.numberOfSeats);
		expect(codesOf(result)).toEqual(expect.arrayContaining(['E02', 'E05']));
	});
});
