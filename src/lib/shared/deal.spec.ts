import { describe, it, expect } from 'vitest';
import { deriveSeatCount, dealCards } from './deal';
import type { Role } from './roles';
import { ALL_ROLES } from './roles';

describe('deriveSeatCount', () => {
	it('sums role counts directly when no thief is configured', () => {
		expect(deriveSeatCount({ 普通狼人: 3, 普通村民: 4, 预言家: 1 })).toBe(8);
	});

	it('subtracts 2 buried cards when 盗贼 is configured', () => {
		expect(deriveSeatCount({ 普通狼人: 3, 普通村民: 4, 盗贼: 1 })).toBe(6);
	});

	it('treats a zero-count 盗贼 entry as not in play', () => {
		expect(deriveSeatCount({ 普通狼人: 3, 普通村民: 4, 盗贼: 0 })).toBe(7);
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
		const config: Partial<Record<Role, number>> = { 普通狼人: 2, 普通村民: 3 };
		const { identities, buried } = dealCards(config, seededRng(1));
		expect(Object.keys(identities)).toHaveLength(5);
		expect(Object.keys(identities).sort()).toEqual(['1', '2', '3', '4', '5']);
		expect(buried).toBeNull();
	});

	it('buries exactly 2 cards when 盗贼 is in play, seats = total - 2', () => {
		const config: Partial<Record<Role, number>> = { 普通狼人: 2, 普通村民: 3, 盗贼: 1 };
		const { identities, buried } = dealCards(config, seededRng(2));
		// total configured = 6, thief in play -> 4 real seats
		expect(Object.keys(identities)).toHaveLength(4);
		expect(buried).not.toBeNull();
		expect(buried).toHaveLength(2);
	});

	it('every configured role appears exactly the configured number of times across seats + buried', () => {
		const config: Partial<Record<Role, number>> = { 普通狼人: 2, 女巫: 1, 普通村民: 3, 盗贼: 1 };
		const { identities, buried } = dealCards(config, seededRng(3));
		const allDealt = [...Object.values(identities), ...(buried ?? [])];
		const counts: Partial<Record<Role, number>> = {};
		for (const role of allDealt) counts[role] = (counts[role] ?? 0) + 1;
		expect(counts).toEqual(config);
	});

	it('rejects nothing outside the known role set (sanity check on ALL_ROLES usage)', () => {
		const config: Partial<Record<Role, number>> = { 普通狼人: 1 };
		const { identities } = dealCards(config, seededRng(4));
		for (const role of Object.values(identities)) {
			expect(ALL_ROLES).toContain(role);
		}
	});
});
