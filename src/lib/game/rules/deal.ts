// Ported from the old shared/deal.ts, RoleId-keyed. Same shuffle, same
// buried-card handling for THIEF, same deliberate non-reproduction of the
// original app's buggy wolf-exclusion-from-buried-pile attempt (see the old
// file's own comment) - spec §D.thief.mustTakeWolfIfBothWolf (M2) replaces
// that concern with a forced-pick rule instead of a biased deal.

import type { RoleId } from '../types';

/**
 * Real player-facing seat count. `roleConfig` totals include the thief's own
 * card, but if THIEF is in play, 2 extra "buried" cards are dealt beyond the
 * seats anyone actually sits in - so real seats = total - 2.
 */
export function deriveSeatCount(roleConfig: Partial<Record<RoleId, number>>): number {
	const total = Object.values(roleConfig).reduce((sum: number, n) => sum + (n ?? 0), 0);
	const hasThief = (roleConfig.THIEF ?? 0) > 0;
	return hasThief ? total - 2 : total;
}

export interface DealResult {
	/** Seat number (as string "1".."N") -> RoleId for every real seat. */
	identities: Record<string, RoleId>;
	/** The 2 buried cards, if THIEF is in play, else null. */
	buried: [RoleId, RoleId] | null;
}

/**
 * Deals roleConfig into a shuffled deck and assigns seats 1..N, burying the
 * last 2 cards if THIEF is in play. Uses a plain uniform shuffle. `rng` is
 * injectable for deterministic tests.
 */
export function dealCards(
	roleConfig: Partial<Record<RoleId, number>>,
	rng: () => number = Math.random
): DealResult {
	const roleList: RoleId[] = [];
	for (const [role, count] of Object.entries(roleConfig) as [RoleId, number | undefined][]) {
		for (let i = 0; i < (count ?? 0); i++) roleList.push(role);
	}

	for (let i = roleList.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[roleList[i], roleList[j]] = [roleList[j], roleList[i]];
	}

	const hasThief = (roleConfig.THIEF ?? 0) > 0;
	const seatCount = hasThief ? roleList.length - 2 : roleList.length;

	const identities: Record<string, RoleId> = {};
	for (let i = 0; i < seatCount; i++) {
		identities[String(i + 1)] = roleList[i];
	}

	let buried: [RoleId, RoleId] | null = null;
	if (hasThief) {
		buried = [roleList[seatCount], roleList[seatCount + 1]];
	}

	return { identities, buried };
}
