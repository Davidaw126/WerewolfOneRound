import { describe, it, expect } from 'vitest';
import { deriveSeatCount, dealCards } from './deal';
import type { RoleId } from '../types';
import { ALL_ROLE_IDS } from '../roleMeta';

describe('deriveSeatCount', () => {
	it('sums role counts directly when no thief is configured', () => {
		expect(deriveSeatCount({ WEREWOLF: 3, VILLAGER: 4, SEER: 1 })).toBe(8);
	});

	it('subtracts 2 buried cards when THIEF is configured', () => {
		expect(deriveSeatCount({ WEREWOLF: 3, VILLAGER: 4, THIEF: 1 })).toBe(6);
	});

	it('treats a zero-count THIEF entry as not in play', () => {
		expect(deriveSeatCount({ WEREWOLF: 3, VILLAGER: 4, THIEF: 0 })).toBe(7);
	});
});

describe('dealCards', () => {
	// Deterministic rng for reproducible shuffle assertions
	function seededRng(seed: number) {
		let s = seed;
		return () => {
			s = (s * 1103515245 + 12345) & 0x7fffffff;
			return s / 0x7fffffff;
		};
	}

	it('assigns exactly seatCount identities and no buried cards without a thief', () => {
		const config: Partial<Record<RoleId, number>> = { WEREWOLF: 2, VILLAGER: 3 };
		const { identities, buried } = dealCards(config, seededRng(1));
		expect(Object.keys(identities)).toHaveLength(5);
		expect(Object.keys(identities).sort()).toEqual(['1', '2', '3', '4', '5']);
		expect(buried).toBeNull();
	});

	it('buries exactly 2 cards when THIEF is in play, seats = total - 2', () => {
		const config: Partial<Record<RoleId, number>> = { WEREWOLF: 2, VILLAGER: 3, THIEF: 1 };
		const { identities, buried } = dealCards(config, seededRng(2));
		// total configured = 6, thief in play -> 4 real seats
		expect(Object.keys(identities)).toHaveLength(4);
		expect(buried).not.toBeNull();
		expect(buried).toHaveLength(2);
	});

	it('every configured role appears exactly the configured number of times across seats + buried', () => {
		const config: Partial<Record<RoleId, number>> = {
			WEREWOLF: 2,
			WITCH: 1,
			VILLAGER: 3,
			THIEF: 1
		};
		const { identities, buried } = dealCards(config, seededRng(3));
		const allDealt = [...Object.values(identities), ...(buried ?? [])];
		const counts: Partial<Record<RoleId, number>> = {};
		for (const role of allDealt) counts[role] = (counts[role] ?? 0) + 1;
		expect(counts).toEqual(config);
	});

	it('never deals a role outside the known 15-role set', () => {
		const config: Partial<Record<RoleId, number>> = { WEREWOLF: 1 };
		const { identities } = dealCards(config, seededRng(4));
		for (const role of Object.values(identities)) {
			expect(ALL_ROLE_IDS).toContain(role);
		}
	});
});
