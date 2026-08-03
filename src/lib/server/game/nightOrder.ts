import { NIGHT1_ORDER, REPEATING_ORDER, type Role } from '../../shared/roles';
import type { NightStage } from '../../shared/gameTypes';

/** Night 1: every present role gets exactly one turn, splicing a couple-reveal
 * stage right after 丘比特 if present. */
export function buildNight1Order(roleConfig: Partial<Record<Role, number>>): NightStage[] {
	const stages: NightStage[] = [];
	for (const role of NIGHT1_ORDER) {
		if ((roleConfig[role] ?? 0) > 0) {
			stages.push({ kind: 'ROLE_TURN', role });
			if (role === '丘比特') {
				stages.push({ kind: 'COUPLE_REVEAL' });
			}
		}
	}
	return stages;
}

/** Night 2+: only the repeating roles recur, filtered to roles with at least
 * one currently living, currently seated holder (evaluated live). This alone
 * subsumes the "buried thief card" special case - a buried card was never a
 * seat holder to begin with, so it's never in `livingRoles`. */
export function buildRepeatingOrder(livingRoles: ReadonlySet<Role>): NightStage[] {
	const stages: NightStage[] = [];
	for (const role of REPEATING_ORDER) {
		if (livingRoles.has(role)) {
			stages.push({ kind: 'ROLE_TURN', role });
		}
	}
	return stages;
}

/** Living, seated roles - the input `buildRepeatingOrder` needs. */
export function livingRolesFrom(
	identities: Record<string, Role>,
	seatedSeatNumbers: Iterable<number>,
	deadSeats: ReadonlySet<number>
): Set<Role> {
	const living = new Set<Role>();
	for (const seat of seatedSeatNumbers) {
		if (deadSeats.has(seat)) continue;
		const role = identities[String(seat)];
		if (role) living.add(role);
	}
	return living;
}
