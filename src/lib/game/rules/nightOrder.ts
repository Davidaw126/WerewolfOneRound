// Ordered night-turn construction, driven entirely by ROLE_META.nightOrder
// instead of the old app's two hand-maintained arrays (NIGHT1_ORDER /
// REPEATING_ORDER) - this IS the spec's data-driven goal (附录A#2) applied to
// turn ordering specifically. `implemented` gates which roles actually get a
// turn built for them yet - see that field's own comment in roleMeta.ts.

import type { RoleId } from '../types';
import { ALL_ROLE_IDS, PACK_MEMBER_ROLES, ROLE_META } from '../roleMeta';

export type NightStage = { kind: 'ROLE_TURN'; role: RoleId } | { kind: 'COUPLE_REVEAL' };

/** §8.5 假环节 (M4, S5): these stages are announced on EVERY night,
 * whether or not their current holder is still alive - a stage that silently
 * stops appearing between nights would otherwise reveal that role's holder
 * just died. This does NOT extend to a role that was never configured on
 * this board at all: the room's composition is public (shown to everyone at
 * setup, before seats are even taken), so there's nothing to protect by
 * conjuring a stage for a role nobody was ever dealt - only "is this
 * specific, known-to-exist role's holder still alive" is the secret 假环节
 * exists to guard. Exported so engine.ts's stage-skip logic (nextStageAfter)
 * and the IO shell's fake-stage auto-advance timer (gameSync.ts) both key
 * off the same set. */
export const ALWAYS_ANNOUNCED_ROLES: ReadonlySet<RoleId> = new Set([
	'WEREWOLF',
	'GUARD',
	'WITCH',
	'SEER',
	'HUNTER',
	// 黑狼王's 确认开枪状态 stage: once configured it must keep running after
	// he dies, or its disappearance would reveal which dead seat he was.
	'BLACK_WOLF_KING'
]);

function nightActiveRolesInOrder(
	roleIds: Iterable<RoleId>,
	roleConfig: Partial<Record<RoleId, number>>
): RoleId[] {
	const idSet = new Set(roleIds);
	for (const r of ALWAYS_ANNOUNCED_ROLES) {
		if ((roleConfig[r] ?? 0) > 0) idSet.add(r);
	}
	// Every pack member wakes in WEREWOLF's stage (the wolf kings have no
	// stage of their own). Without this, a board whose wolves are all special
	// (no plain 普通狼人) got no wolf turn - and no kill - at all.
	for (const r of PACK_MEMBER_ROLES) {
		if (idSet.has(r) || (roleConfig[r] ?? 0) > 0) idSet.add('WEREWOLF');
	}
	return Array.from(idSet)
		.filter((id) => ROLE_META[id].nightOrder !== null && ROLE_META[id].implemented)
		.sort((a, b) => ROLE_META[a].nightOrder! - ROLE_META[b].nightOrder!);
}

/** Night 1: every present, implemented role gets exactly one turn (plus
 * whichever always-announced P0 roles are actually configured on this board -
 * see ALWAYS_ANNOUNCED_ROLES), splicing a couple-reveal stage right after
 * CUPID if present. */
export function buildNight1Order(roleConfig: Partial<Record<RoleId, number>>): NightStage[] {
	const inPlay = ALL_ROLE_IDS.filter((id) => (roleConfig[id] ?? 0) > 0);
	const stages: NightStage[] = [];
	for (const id of nightActiveRolesInOrder(inPlay, roleConfig)) {
		stages.push({ kind: 'ROLE_TURN', role: id });
		if (id === 'CUPID') stages.push({ kind: 'COUPLE_REVEAL' });
	}
	return stages;
}

/** Night 2+: only non-firstNightOnly roles recur (the always-announced set
 * is all non-firstNightOnly already), filtered to roles with at least one
 * currently living, currently seated holder (evaluated live) OR one of the
 * always-announced 5 that's actually configured on this board. This still
 * subsumes the "buried thief card" special case - a buried card was never a
 * seat holder to begin with, so it's never in `livingRoles`. */
export function buildRepeatingOrder(
	livingRoles: ReadonlySet<RoleId>,
	roleConfig: Partial<Record<RoleId, number>>
): NightStage[] {
	return nightActiveRolesInOrder(livingRoles, roleConfig)
		.filter((id) => !ROLE_META[id].firstNightOnly)
		.map((role) => ({ kind: 'ROLE_TURN', role }));
}

/** Living, seated roles - the input buildRepeatingOrder needs. */
export function livingRolesFrom(
	identities: Record<string, RoleId>,
	seatedSeatNumbers: Iterable<number>,
	deadSeats: ReadonlySet<number>
): Set<RoleId> {
	const living = new Set<RoleId>();
	for (const seat of seatedSeatNumbers) {
		if (deadSeats.has(seat)) continue;
		const role = identities[String(seat)];
		if (role) living.add(role);
	}
	return living;
}
