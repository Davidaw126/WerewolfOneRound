// §4.2 ROLE_META - the single data-driven source of role behavior. Per the
// spec's own appendix (附录A#2): "看到 if (role === 'WITCH') 这样的分支散落在
// 多个文件，说明设计错了" - branches on a specific role belong here, as data,
// not scattered through engine/UI code as string comparisons.
//
// `legacyRole` bridges each RoleId back to the current app's Chinese-string
// `Role` type (src/lib/shared/roles.ts) purely so the existing sprite/icon/
// flavor lookups (roleSprites.ts, roleIcons.ts, roleFlavor.ts) can be reused
// as-is during M0-M1, instead of duplicating ~110 lines of hand-authored
// pixel art under a new key. UI components migrate off `legacyRole` in M2+
// as they're touched; it is not meant to be a permanent indirection.

import type { Camp, RoleId } from './types';
import type { Role } from '../shared/roles';

export interface RoleMeta {
	id: RoleId;
	name: string; // spec's own Chinese label (§4.1) - VILLAGER is '平民', not '普通村民'
	legacyRole: Role; // bridge to roleSprites.ts / roleIcons.ts / roleFlavor.ts - see file header
	camp: Camp; // initial camp; getCamp() (M0 winCondition) can override dynamically
	/** "神职" per §3: a GOOD-camp role with a skill. Wolf-team roles are
	 * always false here - SIDE_KILL's isGod filter only ever runs over
	 * GOOD-camp survivors (checkWinCondition), so a wolf role's isGod value
	 * is never read, but false is the honest answer regardless. */
	isGod: boolean;
	/** The role's OWN distinct night step order, or null if it has none. For
	 * WOLF_KING this is the same slot as WEREWOLF (they share the collective
	 * kill decision, no separate action of their own at night - self-explode
	 * is a DAY action). WOLF_BEAUTY/NIGHTMARE get their own later slot
	 * (27/28) distinct from the shared wolf-kill slot (25), matching how
	 * this app's NIGHT1_ORDER already sequences 狼美人 as its own turn after
	 * 普通狼人. */
	nightOrder: number | null;
	firstNightOnly: boolean;
	actsOnFirstNight: boolean;
	targetCount: number;
	/** A per-role DEFAULT/capability baseline (spec §4.2). For SEER/WITCH/
	 * GUARD/CUPID, RuleConfig also has a dedicated, user-configurable switch
	 * (seer.canCheckSelf / witch.canPoisonSelf / guard.canGuardSelf /
	 * cupid.canLinkSelf) - that switch is the actual runtime authority the
	 * validators (nightRules.ts) read for those four; this field is just the
	 * reference value matching each one's RuleConfig default, not read
	 * directly for them. For roles with no such switch (WEREWOLF's B11
	 * self-kill, WILD_CHILD's idol-can't-be-self), this IS the authority. */
	canTargetSelf: boolean;
	canTargetDead: boolean; // always false per spec - reserved for future
	visibleTeammates: RoleId[];
	maxUses: number | null; // null = unlimited; WITCH is tracked via two separate flags, not this
	/**
	 * Not a spec field - an M0-specific bridge. The spec's own §4.1 table
	 * gives every role a nightOrder, but this app's actual mechanics only
	 * covered 8 of the 15 at the M0 rewrite's start (the old POWER_ROLES:
	 * WEREWOLF, SEER, WITCH, HUNTER, GUARD, WOLF_BEAUTY, CUPID, THIEF).
	 * IDIOT/KNIGHT/WOLF_KING landed in M3 (reveal-on-exile, duel, self-explode
	 * + shot); NIGHTMARE/DREAM_WEAVER/WILD_CHILD landed in M7. Every entry's
	 * nightOrder/camp/isGod was already spec-correct before its mechanics
	 * landed, so ROLE_META itself never needed revisiting - only this flag,
	 * which nightOrder.ts filters on to keep the engine from building a night
	 * turn (or, for IDIOT/KNIGHT/WOLF_KING pre-M3, any mechanic at all) for a
	 * role before it actually works.
	 */
	implemented: boolean;
	/** The shape of this role's OWN night turn - what its holder does when
	 * their role is called (null = no night turn of its own). In the pack's
	 * shared WEREWOLF turn every pack member picks a seat regardless. */
	nightTurn: NightTurn | null;
}

/** pick: choose a seat · potions: the witch's two potions · link: choose two
 * seats · thief: choose a buried card · status: look at your 开枪状态 and
 * confirm, nothing to submit. */
export type NightTurn = 'pick' | 'potions' | 'link' | 'thief' | 'status';

export const ROLE_META: Record<RoleId, RoleMeta> = {
	VILLAGER: {
		id: 'VILLAGER',
		name: '平民',
		legacyRole: '普通村民',
		camp: 'GOOD',
		isGod: false,
		nightOrder: null,
		firstNightOnly: false,
		actsOnFirstNight: false,
		targetCount: 0,
		canTargetSelf: false,
		canTargetDead: false,
		visibleTeammates: [],
		maxUses: null,
		implemented: true,
		nightTurn: null
	},
	SEER: {
		id: 'SEER',
		name: '预言家',
		legacyRole: '预言家',
		camp: 'GOOD',
		isGod: true,
		nightOrder: 40,
		firstNightOnly: false,
		actsOnFirstNight: true,
		targetCount: 1,
		canTargetSelf: true, // today's actual behavior - see the field comment above
		canTargetDead: false,
		visibleTeammates: [],
		maxUses: null,
		implemented: true,
		nightTurn: 'pick'
	},
	WITCH: {
		id: 'WITCH',
		name: '女巫',
		legacyRole: '女巫',
		camp: 'GOOD',
		isGod: true,
		nightOrder: 30,
		firstNightOnly: false,
		actsOnFirstNight: true,
		targetCount: 1, // the poison target; the antidote is a yes/no on the already-known kill victim
		canTargetSelf: true, // today's actual behavior - see the field comment above; self-rescue is separate
		canTargetDead: false,
		visibleTeammates: [],
		maxUses: null, // tracked via witchAntidoteUsed/witchPoisonUsed on GameState instead
		implemented: true,
		nightTurn: 'potions'
	},
	HUNTER: {
		id: 'HUNTER',
		name: '猎人',
		legacyRole: '猎人',
		camp: 'GOOD',
		isGod: true,
		nightOrder: 50, // HUNTER_STATUS - a status confirmation, not a real decision
		firstNightOnly: false,
		actsOnFirstNight: true,
		targetCount: 0,
		canTargetSelf: false,
		canTargetDead: false,
		visibleTeammates: [],
		maxUses: null,
		implemented: true,
		nightTurn: 'status'
	},
	GUARD: {
		id: 'GUARD',
		name: '守卫',
		legacyRole: '守卫',
		camp: 'GOOD',
		isGod: true,
		nightOrder: 20,
		firstNightOnly: false,
		actsOnFirstNight: true,
		targetCount: 1,
		canTargetSelf: true, // spec default guard.canGuardSelf = true
		canTargetDead: false,
		visibleTeammates: [],
		maxUses: null,
		implemented: true,
		nightTurn: 'pick'
	},
	IDIOT: {
		id: 'IDIOT',
		name: '白痴',
		legacyRole: '白痴',
		camp: 'GOOD',
		isGod: true,
		nightOrder: null, // no night action - reveal-on-exile is a day mechanic (M3)
		firstNightOnly: false,
		actsOnFirstNight: false,
		targetCount: 0,
		canTargetSelf: false,
		canTargetDead: false,
		visibleTeammates: [],
		maxUses: null,
		implemented: true,
		nightTurn: null
	},
	KNIGHT: {
		id: 'KNIGHT',
		name: '骑士',
		legacyRole: '骑士',
		camp: 'GOOD',
		isGod: true,
		nightOrder: null, // day-only duel, driven by the new KNIGHT_DUEL action (M3)
		firstNightOnly: false,
		actsOnFirstNight: false,
		targetCount: 1,
		canTargetSelf: false,
		canTargetDead: false,
		visibleTeammates: [],
		maxUses: 1, // spec default knight.onceOnly = true
		implemented: true,
		nightTurn: null
	},
	DREAM_WEAVER: {
		id: 'DREAM_WEAVER',
		name: '摄梦人',
		legacyRole: '摄梦人',
		camp: 'GOOD',
		isGod: true,
		nightOrder: 45,
		firstNightOnly: false,
		actsOnFirstNight: true,
		targetCount: 1,
		canTargetSelf: false,
		canTargetDead: false,
		visibleTeammates: [],
		maxUses: null,
		implemented: true,
		nightTurn: 'pick'
	},
	CUPID: {
		id: 'CUPID',
		name: '丘比特',
		legacyRole: '丘比特',
		camp: 'GOOD', // dynamic: getCamp() returns LOVERS for a cross-team link
		isGod: true,
		nightOrder: 12,
		firstNightOnly: true,
		actsOnFirstNight: true,
		targetCount: 2,
		canTargetSelf: true, // spec default cupid.canLinkSelf = true
		canTargetDead: false,
		visibleTeammates: [],
		maxUses: null,
		implemented: true,
		nightTurn: 'link'
	},
	THIEF: {
		id: 'THIEF',
		name: '盗贼',
		legacyRole: '盗贼',
		camp: 'GOOD', // dynamic: becomes whichever role they pick
		isGod: true,
		nightOrder: 10,
		firstNightOnly: true,
		actsOnFirstNight: true,
		targetCount: 0, // picks a buried CARD (thiefPick), not a seat
		canTargetSelf: false,
		canTargetDead: false,
		visibleTeammates: [],
		maxUses: null,
		implemented: true,
		nightTurn: 'thief'
	},
	WILD_CHILD: {
		id: 'WILD_CHILD',
		name: '野孩子',
		legacyRole: '野孩子',
		camp: 'GOOD', // dynamic: becomes WEREWOLF if the idol dies
		isGod: true,
		nightOrder: 14,
		firstNightOnly: true,
		actsOnFirstNight: true,
		targetCount: 1,
		canTargetSelf: false, // spec: idol "不可选自己"
		canTargetDead: false,
		visibleTeammates: [],
		maxUses: null,
		implemented: true,
		nightTurn: 'pick'
	},
	WEREWOLF: {
		id: 'WEREWOLF',
		name: '普通狼人',
		legacyRole: '普通狼人',
		camp: 'WEREWOLF',
		isGod: false,
		nightOrder: 25,
		firstNightOnly: false,
		actsOnFirstNight: true,
		targetCount: 1,
		canTargetSelf: true, // B11: 狼人刀自己人 allowed
		canTargetDead: false,
		visibleTeammates: ['WEREWOLF', 'WOLF_KING', 'BLACK_WOLF_KING', 'WOLF_BEAUTY', 'NIGHTMARE'],
		maxUses: null,
		implemented: true,
		nightTurn: 'pick'
	},
	WOLF_KING: {
		id: 'WOLF_KING',
		name: '白狼王',
		legacyRole: '白狼王',
		camp: 'WEREWOLF',
		isGod: false,
		// null, not 25 (WEREWOLF's slot): WOLF_KING has no SEPARATE night stage
		// of its own - it shares the single collective wolf-kill decision, so
		// giving it its own nightOrder would produce a second, duplicate
		// "狼人请睁眼" stage whenever both roles are in play. nightOrder.ts's
		// stage builder synthesizes the shared WEREWOLF stage even on a
		// WOLF_KING-only board (no regular WEREWOLF dealt at all); engine.ts's
		// SUBMIT_NIGHT_ACTION handler and turnContext.ts's notifyRoleHolders
		// both special-case WOLF_KING into that same WEREWOLF stage.
		nightOrder: null,
		firstNightOnly: false,
		actsOnFirstNight: true,
		targetCount: 1,
		canTargetSelf: true,
		canTargetDead: false,
		visibleTeammates: ['WEREWOLF', 'WOLF_KING', 'BLACK_WOLF_KING', 'WOLF_BEAUTY', 'NIGHTMARE'],
		maxUses: null,
		implemented: true,
		nightTurn: 'pick'
	},
	// 黑狼王: wakes with the pack and shares its one kill (actsInStage below).
	// When he dies to the wolf kill, a vote, or a shot, he takes one player
	// with him like the hunter - but not when poisoned, when he
	// self-explodes, or via 殉情 (see nightResolution.ts's canTriggerShoot).
	// His own stage is the hunter's 确认开枪状态 counterpart: a status
	// confirmation after the witch, not a decision.
	BLACK_WOLF_KING: {
		id: 'BLACK_WOLF_KING',
		name: '黑狼王',
		legacyRole: '黑狼王',
		camp: 'WEREWOLF',
		isGod: false,
		nightOrder: 51, // BLACK_WOLF_KING_STATUS - right after HUNTER_STATUS
		firstNightOnly: false,
		actsOnFirstNight: true,
		targetCount: 1,
		canTargetSelf: true,
		canTargetDead: false,
		visibleTeammates: ['WEREWOLF', 'WOLF_KING', 'BLACK_WOLF_KING', 'WOLF_BEAUTY', 'NIGHTMARE'],
		maxUses: null,
		implemented: true,
		nightTurn: 'status'
	},
	WOLF_BEAUTY: {
		id: 'WOLF_BEAUTY',
		name: '狼美人',
		legacyRole: '狼美人',
		camp: 'WEREWOLF',
		isGod: false,
		nightOrder: 27,
		firstNightOnly: false,
		actsOnFirstNight: true,
		targetCount: 1,
		canTargetSelf: false,
		canTargetDead: false,
		visibleTeammates: ['WEREWOLF', 'WOLF_KING', 'BLACK_WOLF_KING', 'WOLF_BEAUTY', 'NIGHTMARE'],
		maxUses: null,
		implemented: true,
		nightTurn: 'pick'
	},
	NIGHTMARE: {
		id: 'NIGHTMARE',
		name: '恶灵骑士',
		legacyRole: '恶灵骑士',
		camp: 'WEREWOLF',
		isGod: false,
		nightOrder: 28,
		firstNightOnly: false,
		actsOnFirstNight: true,
		targetCount: 1,
		canTargetSelf: false,
		canTargetDead: false,
		visibleTeammates: ['WEREWOLF', 'WOLF_KING', 'BLACK_WOLF_KING', 'WOLF_BEAUTY', 'NIGHTMARE'],
		maxUses: null,
		implemented: true,
		nightTurn: 'pick'
	}
};

export const ALL_ROLE_IDS: RoleId[] = Object.keys(ROLE_META) as RoleId[];

export function roleMeta(id: RoleId): RoleMeta {
	return ROLE_META[id];
}

/** §4.1 v1.0 priority tiers - P0 must work, P1/P2 can land later (M3/M7). */
export const P0_ROLES: RoleId[] = [
	'VILLAGER',
	'SEER',
	'WITCH',
	'HUNTER',
	'GUARD',
	'IDIOT',
	'WEREWOLF'
];
export const P1_ROLES: RoleId[] = [
	'CUPID',
	'WOLF_KING',
	'BLACK_WOLF_KING',
	'WOLF_BEAUTY',
	'KNIGHT'
];

/** Roles that wake in the shared WEREWOLF stage and make its one collective
 * kill. The single source of truth: a hard-coded "WEREWOLF or WOLF_KING"
 * check elsewhere is how a lone surviving wolf king's real turn ended up
 * treated as an absent role's 假环节 stage (auto-skipped after 4s, kill
 * lost) once the regular wolves were dead. */
export const PACK_KILL_ROLES: ReadonlySet<RoleId> = new Set([
	'WEREWOLF',
	'WOLF_KING',
	'BLACK_WOLF_KING'
]);

/** Status-only stages (确认开枪状态): nothing to submit; every holder taps
 * 确认 and the night moves on. */
export const STATUS_STAGE_ROLES: ReadonlySet<RoleId> = new Set(
	ALL_ROLE_IDS.filter((id) => ROLE_META[id].nightTurn === 'status')
);

/** Every wolf who wakes in the WEREWOLF stage and helps choose its kill:
 * the wolf kings, plus 狼美人 and 恶灵骑士 - who also keep their own later
 * stage for their own skill (charm / fear). A kill made by any of them is
 * recorded in submittedRoles as 'WEREWOLF'. */
export const PACK_MEMBER_ROLES: ReadonlySet<RoleId> = new Set([
	...PACK_KILL_ROLES,
	'WOLF_BEAUTY',
	'NIGHTMARE'
]);

/** Whether a holder of `playerRole` acts during `stageRole`'s night stage. */
export function actsInStage(stageRole: RoleId, playerRole: RoleId): boolean {
	return (
		playerRole === stageRole || (stageRole === 'WEREWOLF' && PACK_MEMBER_ROLES.has(playerRole))
	);
}
export const P2_ROLES: RoleId[] = ['THIEF', 'WILD_CHILD', 'DREAM_WEAVER', 'NIGHTMARE'];
