// §5.1 预设板子 - the 7 fixed boards (the 8th roster entry, "自定义", isn't a
// real preset - it's just "no preset picked, free selection", the UI's own
// default state, so it has no data entry here).

import type { RoleId } from '../types';

export interface PresetBoard {
	name: string;
	playerCount: number;
	roleConfig: Partial<Record<RoleId, number>>;
}

export const PRESET_BOARDS: readonly PresetBoard[] = [
	{
		name: '6人新手场',
		playerCount: 6,
		roleConfig: { WEREWOLF: 2, SEER: 1, WITCH: 1, VILLAGER: 2 }
	},
	{
		name: '8人局',
		playerCount: 8,
		roleConfig: { WEREWOLF: 2, SEER: 1, WITCH: 1, HUNTER: 1, VILLAGER: 3 }
	},
	{
		name: '9人局',
		playerCount: 9,
		roleConfig: { WEREWOLF: 3, SEER: 1, WITCH: 1, HUNTER: 1, VILLAGER: 3 }
	},
	{
		name: '12人标准场',
		playerCount: 12,
		roleConfig: { WEREWOLF: 4, SEER: 1, WITCH: 1, HUNTER: 1, IDIOT: 1, VILLAGER: 4 }
	},
	{
		name: '12人守卫场',
		playerCount: 12,
		roleConfig: { WEREWOLF: 4, SEER: 1, WITCH: 1, HUNTER: 1, GUARD: 1, VILLAGER: 4 }
	},
	{
		name: '12人狼王守卫场',
		playerCount: 12,
		roleConfig: { WEREWOLF: 3, WOLF_KING: 1, SEER: 1, WITCH: 1, HUNTER: 1, GUARD: 1, VILLAGER: 4 }
	},
	{
		name: '12人情侣场',
		playerCount: 12,
		roleConfig: { WEREWOLF: 4, SEER: 1, WITCH: 1, HUNTER: 1, CUPID: 1, VILLAGER: 4 }
	}
];
