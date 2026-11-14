import type { RoleId } from '../game/types';
import { roleIdToLegacy, legacyToRoleId } from '../game/roleBridge';

// Display-side role names. Everything on the wire and in storage uses the
// engine's RoleId; this Chinese-name roster (the original app's full 23-role
// room-settings screen) survives only as the key of the display tables -
// sprites, flavor lines, names - which convert a RoleId at their edge.
//
// The complete role roster, matching the original app's room-settings screen exactly.
// Only the 8 in POWER_ROLES have an implemented night action - everyone else is
// tracked for alive/dead + win-condition counting only. This is a deliberate,
// preserved scope limit, not a gap to fill in later.
export const ALL_ROLES = [
	'普通狼人',
	'预言家',
	'女巫',
	'猎人',
	'守卫',
	'狼美人',
	'丘比特',
	'盗贼',
	'白痴',
	'骑士',
	'禁言长老',
	'摄梦人',
	'潜行者',
	'高级村民',
	'老流氓',
	'普通村民',
	'白狼王',
	'黑狼王',
	'隐狼',
	'恶魔',
	'恶灵骑士',
	'梦魇',
	'机械狼',
	'野孩子'
] as const;

export type Role = (typeof ALL_ROLES)[number];

export const WOLF_TEAM_ROLES: ReadonlySet<Role> = new Set([
	'普通狼人',
	'白狼王',
	'黑狼王',
	'隐狼',
	'恶魔',
	'狼美人',
	'恶灵骑士',
	'梦魇',
	'机械狼'
]);

/** The camp a role's card shows, keyed by the engine's role id. */
export function roleTeam(role: RoleId): 'wolf' | 'village' {
	return WOLF_TEAM_ROLES.has(roleIdToLegacy(role)) ? 'wolf' : 'village';
}

export const POWER_ROLES = [
	'普通狼人',
	'预言家',
	'女巫',
	'猎人',
	'守卫',
	'狼美人',
	'丘比特',
	'盗贼'
] as const;
export type PowerRole = (typeof POWER_ROLES)[number];

export function isPowerRole(role: Role): role is PowerRole {
	return (POWER_ROLES as readonly Role[]).includes(role);
}

// Night 1: every present role gets exactly one turn, in this precedence order.
// 情侣 (couple reveal) is spliced in immediately after 丘比特 by nightOrder.ts, not listed here.
export const NIGHT1_ORDER: Role[] = [
	'盗贼',
	'丘比特',
	'野孩子',
	'普通狼人',
	'守卫',
	'预言家',
	'女巫',
	'猎人',
	'狼美人'
];

// Night 2+: only these roles recur. Filtered further, at build time, to roles with
// at least one currently-living seated holder (see nightOrder.ts).
export const REPEATING_ORDER: Role[] = ['普通狼人', '守卫', '预言家', '女巫', '猎人', '狼美人'];

/** The roles a room can be set up with, in the original room-settings
 * screen's order: the 17 the engine implements. The other 6 names above
 * (高级村民/老流氓/隐狼/恶魔/机械狼/梦魇) have no RoleId. */
export const PICKABLE_ROLES: readonly RoleId[] = ALL_ROLES.map(legacyToRoleId).filter(
	(r): r is RoleId => r !== null
);
