import type { Role } from './roles';

/**
 * Real player-facing seat count. `roleConfig` totals include the thief's own
 * card, but if 盗贼 is in play, 2 extra "buried" cards are dealt beyond the
 * seats anyone actually sits in - so real seats = total - 2.
 */
export function deriveSeatCount(roleConfig: Partial<Record<Role, number>>): number {
	const total = Object.values(roleConfig).reduce((sum: number, n) => sum + (n ?? 0), 0);
	const hasThief = (roleConfig['盗贼'] ?? 0) > 0;
	return hasThief ? total - 2 : total;
}

export interface DealResult {
	/** Seat number (as string "1".."N") -> Role for every real seat. */
	identities: Record<string, Role>;
	/** The 2 buried cards, if 盗贼 is in play, else null. */
	buried: [Role, Role] | null;
}

/**
 * Deals roleConfig into a shuffled deck and assigns seats 1..N, burying the
 * last 2 cards if 盗贼 is in play. Uses a plain uniform shuffle - the original
 * app attempted (buggily - it checked the same condition twice and only ever
 * inspected one buried slot) to keep wolf-team cards out of the buried pile;
 * that never actually worked, so it's not reproduced here. `rng` is injectable
 * for deterministic tests.
 */
export function dealCards(
	roleConfig: Partial<Record<Role, number>>,
	rng: () => number = Math.random
): DealResult {
	const roleList: Role[] = [];
	for (const [role, count] of Object.entries(roleConfig) as [Role, number | undefined][]) {
		for (let i = 0; i < (count ?? 0); i++) roleList.push(role);
	}

	for (let i = roleList.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[roleList[i], roleList[j]] = [roleList[j], roleList[i]];
	}

	const hasThief = (roleConfig['盗贼'] ?? 0) > 0;
	const seatCount = hasThief ? roleList.length - 2 : roleList.length;

	const identities: Record<string, Role> = {};
	for (let i = 0; i < seatCount; i++) {
		identities[String(i + 1)] = roleList[i];
	}

	let buried: [Role, Role] | null = null;
	if (hasThief) {
		buried = [roleList[seatCount], roleList[seatCount + 1]];
	}

	return { identities, buried };
}
