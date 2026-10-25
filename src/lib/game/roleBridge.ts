// Bridges the wire/UI layer (still speaking the old Chinese-string `Role`
// type from shared/roles.ts - untouched until M2's full role-roster rewrite)
// to the new engine (which only knows the spec's 15-role `RoleId`). Every
// value here is derived from ROLE_META.legacyRole so the two can never drift
// out of sync independently.
//
// Lives alongside types.ts/roleMeta.ts/engine.ts (not under server/) because
// it's pure data over ROLE_META - no Redis, no session, nothing IO-bound -
// and RoleConfigPanel.svelte needs it client-side to narrow the role picker,
// same as the M1 IO shell needs it server-side.

import type { RoleId } from './types';
import { ALL_ROLE_IDS, ROLE_META } from './roleMeta';
import type { Role } from '../shared/roles';

const LEGACY_TO_ROLE_ID: Partial<Record<Role, RoleId>> = {};
for (const id of ALL_ROLE_IDS) {
	LEGACY_TO_ROLE_ID[ROLE_META[id].legacyRole] = id;
}

/** The old-app roster has 7 roles (禁言长老/高级村民/老流氓/隐狼/恶魔/
 * 机械狼/梦魇) with no counterpart in the new 15-role RoleId set (M0 plan
 * decision 3) - null here means exactly that, not a bug. */
export function legacyToRoleId(role: Role): RoleId | null {
	return LEGACY_TO_ROLE_ID[role] ?? null;
}

export function roleIdToLegacy(id: RoleId): Role {
	return ROLE_META[id].legacyRole;
}

/** The subset of the old 23-role roster the new engine can actually
 * represent - used to narrow the room-config picker (RoleConfigPanel.svelte)
 * and to validate a submitted roleConfig before anyone deals cards for it. */
export const SUPPORTED_LEGACY_ROLES: readonly Role[] = ALL_ROLE_IDS.map(
	(id) => ROLE_META[id].legacyRole
);

export function isSupportedLegacyRole(role: Role): boolean {
	return LEGACY_TO_ROLE_ID[role] !== undefined;
}
