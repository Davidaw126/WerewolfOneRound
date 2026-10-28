// How each role's night turn is presented: the Host's narration call-out,
// the line asking a player to choose, and which prompt they get. The turn's
// shape itself (pick a seat, potions, ...) is the engine's roleMeta
// `nightTurn`; this adds only what's said and shown, keyed by the same
// RoleId, so a role's night is described here and in roleMeta - nowhere else.

import type { RoleId } from '$lib/game/types';
import { ROLE_META, PACK_KILL_ROLES, type NightTurn } from '$lib/game/roleMeta';
import type { Strings } from '$lib/shared/i18n/types';

type NarrationKey = keyof Strings['narration'];
type PromptKey = keyof Strings['nightPrompt'];

interface RoleNight {
	/** The Host's call-out when this role's turn starts. */
	narration: NarrationKey;
	/** Asks the player to choose (pick turns only). */
	selectLabel?: PromptKey;
	/** Shown on a status turn before 确认. */
	statusLabel?: PromptKey;
}

const ROLE_NIGHT: Partial<Record<RoleId, RoleNight>> = {
	WEREWOLF: { narration: 'wolfTurn', selectLabel: 'selectWolfTarget' },
	WOLF_KING: { narration: 'wolfTurn', selectLabel: 'selectWolfTarget' },
	SEER: { narration: 'seerTurn', selectLabel: 'selectSeerTarget' },
	WITCH: { narration: 'witchTurn' },
	GUARD: { narration: 'guardTurn', selectLabel: 'selectGuardTarget' },
	WOLF_BEAUTY: { narration: 'wolfBeautyTurn', selectLabel: 'selectWolfBeautyTarget' },
	CUPID: { narration: 'cupidTurn' },
	THIEF: { narration: 'thiefTurn' },
	HUNTER: { narration: 'hunterTurn', statusLabel: 'hunterNoActionNeeded' },
	// Only his own 确认开枪状态 turn is narrated as his: during the pack's turn
	// the Host's stage is WEREWOLF.
	BLACK_WOLF_KING: { narration: 'blackWolfKingTurn', statusLabel: 'statusNoActionNeeded' },
	WILD_CHILD: { narration: 'wildChildTurn', selectLabel: 'selectWildChildTarget' },
	DREAM_WEAVER: { narration: 'dreamWeaverTurn', selectLabel: 'selectDreamWeaverTarget' },
	NIGHTMARE: { narration: 'nightmareTurn', selectLabel: 'selectNightmareTarget' }
};

/** The Host's call-out for a role's turn, if it has one. */
export function narrationFor(role: RoleId): NarrationKey | null {
	return ROLE_NIGHT[role]?.narration ?? null;
}

/** Which prompt a player holding `role` gets on this turn. In the pack's
 * shared kill turn every pack member picks the kill, whatever their own
 * turn looks like. */
export function promptFor(role: RoleId, packTurn: boolean): NightTurn | null {
	return packTurn ? 'pick' : ROLE_META[role].nightTurn;
}

/** The line asking the player to choose. The pack's kill turn - and a wolf
 * king, whose only pick is the kill - always asks for the kill. */
export function selectLabelFor(role: RoleId, packTurn: boolean): PromptKey | null {
	if (packTurn || PACK_KILL_ROLES.has(role)) return 'selectWolfTarget';
	return ROLE_NIGHT[role]?.selectLabel ?? null;
}

export function statusLabelFor(role: RoleId): PromptKey {
	return ROLE_NIGHT[role]?.statusLabel ?? 'statusNoActionNeeded';
}
