// Converts between the engine's RoleId (used on the wire and in storage) and
// the Chinese role names the display tables are keyed by (shared/roles.ts:
// names, sprites, flavor lines). Only display lookups call this - plus
// roomRepo, to read rooms saved with Chinese names before roles were stored
// as ids. Every value is derived from ROLE_META.legacyRole so the two can
// never drift apart.

import type { RoleId } from './types';
import { ALL_ROLE_IDS, ROLE_META } from './roleMeta';
import type { Role } from '../shared/roles';

const LEGACY_TO_ROLE_ID: Partial<Record<Role, RoleId>> = {};
for (const id of ALL_ROLE_IDS) {
	LEGACY_TO_ROLE_ID[ROLE_META[id].legacyRole] = id;
}

/** The old-app roster has 6 roles (高级村民/老流氓/隐狼/恶魔/机械狼/梦魇)
 * with no RoleId (M0 plan decision 3) - null here means exactly that, not
 * a bug. */
export function legacyToRoleId(role: Role): RoleId | null {
	return LEGACY_TO_ROLE_ID[role] ?? null;
}

export function roleIdToLegacy(id: RoleId): Role {
	return ROLE_META[id].legacyRole;
}
