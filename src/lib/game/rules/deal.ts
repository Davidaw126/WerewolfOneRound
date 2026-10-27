// The one deal: shuffles a RoleId-keyed role setup into seats, burying the
// last 2 cards if THIEF is in play. Used when seating starts and on every
// Re-deal (anti-repeat via `previous`).

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

/** Uniform float in [0, 1) from the platform CSPRNG (Web Crypto exists in
 * both Node 22+ and every browser). Math.random is fine for gameplay, but a
 * cryptographic source removes any argument about predictable deals. */
export function secureRandom(): number {
	const buf = new Uint32Array(1);
	globalThis.crypto.getRandomValues(buf);
	return buf[0] / 0x1_0000_0000;
}

function shuffledDeck(roleConfig: Partial<Record<RoleId, number>>, rng: () => number): RoleId[] {
	const roleList: RoleId[] = [];
	for (const [role, count] of Object.entries(roleConfig) as [RoleId, number | undefined][]) {
		for (let i = 0; i < (count ?? 0); i++) roleList.push(role);
	}
	// Fisher-Yates.
	for (let i = roleList.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[roleList[i], roleList[j]] = [roleList[j], roleList[i]];
	}
	return roleList;
}

function toDeal(roleList: RoleId[], hasThief: boolean): DealResult {
	const seatCount = hasThief ? roleList.length - 2 : roleList.length;
	const identities: Record<string, RoleId> = {};
	for (let i = 0; i < seatCount; i++) identities[String(i + 1)] = roleList[i];
	const buried: [RoleId, RoleId] | null = hasThief
		? [roleList[seatCount], roleList[seatCount + 1]]
		: null;
	return { identities, buried };
}

/** How many candidate shuffles the anti-repeat deal draws from. Small on
 * purpose: enough to almost always dodge a repeated special role, few enough
 * that the result still feels like a real shuffle rather than a rotation. */
const ANTI_REPEAT_CANDIDATES = 24;

/** How "repeated" a deal feels against the previous one: a seat dealt the
 * same role again costs 1 / (copies of that role). Getting SEER twice in a
 * row (1 copy) is very noticeable; getting VILLAGER again when there are 4 is
 * barely noticeable and mostly just chance. */
function repeatScore(
	deal: DealResult,
	previous: Record<string, RoleId>,
	roleConfig: Partial<Record<RoleId, number>>
): number {
	let score = 0;
	for (const [seat, role] of Object.entries(deal.identities)) {
		if (previous[seat] === role) score += 1 / Math.max(1, roleConfig[role] ?? 1);
	}
	return score;
}

/**
 * Deals roleConfig into a shuffled deck and assigns seats 1..N, burying the
 * last 2 cards if THIEF is in play. The original app attempted (buggily - it
 * checked the same condition twice and only ever inspected one buried slot)
 * to keep wolf-team cards out of the buried pile; that never actually worked,
 * so it's not reproduced here.
 *
 * `previous` (the seat -> role map of the last deal in this room) turns on
 * anti-repeat: several candidate shuffles are drawn and the one that gives
 * the fewest seats their previous role is kept (ties go to whichever was
 * drawn first, so it stays random). Every configured card is still dealt
 * exactly once either way. `rng` is injectable for deterministic tests.
 */
export function dealCards(
	roleConfig: Partial<Record<RoleId, number>>,
	rng: () => number = secureRandom,
	previous?: Record<string, RoleId> | null
): DealResult {
	const hasThief = (roleConfig.THIEF ?? 0) > 0;
	const first = toDeal(shuffledDeck(roleConfig, rng), hasThief);
	if (!previous || Object.keys(previous).length === 0) return first;

	let best = first;
	let bestScore = repeatScore(first, previous, roleConfig);
	for (let i = 1; i < ANTI_REPEAT_CANDIDATES && bestScore > 0; i++) {
		const candidate = toDeal(shuffledDeck(roleConfig, rng), hasThief);
		const score = repeatScore(candidate, previous, roleConfig);
		if (score < bestScore) {
			best = candidate;
			bestScore = score;
		}
	}
	return best;
}
