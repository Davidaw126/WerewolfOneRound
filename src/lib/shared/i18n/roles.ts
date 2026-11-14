import { ALL_ROLES, type Role } from '../roles';
import { ROLE_FLAVOR } from '../roleFlavor';
import type { RoleId } from '../../game/types';
import { roleIdToLegacy } from '../../game/roleBridge';
import type { Lang } from './types';

// The wire-facing `Role` type IS the Chinese name (a deliberate, unchanged
// design decision - see roles.ts's own header comment) - so "translating"
// role names for zh is just the identity map, keeping the lookup API
// (`roleName(role, lang)`) uniform regardless of language instead of every
// call site special-casing zh as "just use the role value directly".
const ZH_ROLE_NAME: Record<Role, string> = Object.fromEntries(
	ALL_ROLES.map((r) => [r, r])
) as Record<Role, string>;

const EN_ROLE_NAME: Record<Role, string> = {
	普通狼人: 'Werewolf',
	预言家: 'Seer',
	女巫: 'Witch',
	猎人: 'Hunter',
	守卫: 'Guard',
	狼美人: 'Wolf Beauty',
	丘比特: 'Cupid',
	盗贼: 'Thief',
	白痴: 'Idiot',
	骑士: 'Knight',
	禁言长老: 'Silencer Elder',
	潜行者: 'Stalker',
	摄梦人: 'Dream Weaver',
	高级村民: 'Elite Villager',
	老流氓: 'Rogue',
	普通村民: 'Villager',
	白狼王: 'White Wolf King',
	黑狼王: 'Black Wolf King',
	隐狼: 'Hidden Wolf',
	恶魔: 'Demon',
	恶灵骑士: 'Nightmare Knight',
	梦魇: 'Night Terror',
	机械狼: 'Mecha Wolf',
	野孩子: 'Wild Child'
};

const ROLE_NAME: Record<Lang, Record<Role, string>> = { zh: ZH_ROLE_NAME, en: EN_ROLE_NAME };

export function roleName(role: RoleId, lang: Lang): string {
	return ROLE_NAME[lang][roleIdToLegacy(role)];
}

// English flavor lines - not literal translations of ROLE_FLAVOR
// (src/lib/shared/roleFlavor.ts) so much as equivalent evocative one-liners,
// same length/tone target as the originals.
const EN_ROLE_FLAVOR: Record<Role, string> = {
	普通狼人: 'Wakes with the dark to drink the blood of one good soul',
	预言家: "Borrows the gods' own sight to test truth from lies, night after night",
	女巫: 'One antidote to save a life, one poison to take one',
	猎人: 'Falling, he pulls the trigger and takes one more soul down with him',
	守卫: 'Spreads wings each night to shield one soul from harm',
	狼美人: 'One kiss seals a shared fate, and a shared death',
	丘比特: "Fires love's arrow, binding two fates as one",
	盗贼: 'Slips into the deck to steal a brand new face',
	白痴: 'Even voted out, refuses to close his eyes just yet',
	骑士: 'Draws his blade by daylight, duels a wolf before all to see',
	禁言长老: "One word seals a target's voice for the whole day",
	潜行者: 'Marks the one the vote spared, and settles it after dark',
	摄梦人: 'Weaves a dreamless sleep that never lets its victim wake',
	高级村民: 'A seasoned good soul hiding in the crowd, impossible to read',
	老流氓: 'Even cast out, drags one more down as company',
	普通村民: 'Unarmed, reading loyalty and treachery with nothing but a pair of eyes',
	白狼王: 'Self-destructs in flame, taking one prey down with him',
	黑狼王: 'Strikes back in death, leaving one more body where the shot rings out',
	隐狼: 'Blends among the good - even his own pack may not know him',
	恶魔: 'The power behind the wolves, the true king of the dark',
	恶灵骑士: "Slain and risen again - a wolf wearing a knight's skin",
	梦魇: 'The nightmare that unravels the night, turning all order upside down',
	机械狼: 'A wolf of steel and gears, one poison can hardly touch',
	野孩子: 'Chooses an idol to follow - his own fate now tied to theirs'
};

export function roleFlavor(role: RoleId, lang: Lang): string {
	const key = roleIdToLegacy(role);
	return lang === 'zh' ? ROLE_FLAVOR[key] : EN_ROLE_FLAVOR[key];
}

export function campName(team: 'wolf' | 'village', lang: Lang): string {
	if (lang === 'zh') return team === 'wolf' ? '狼人阵营' : '好人阵营';
	return team === 'wolf' ? 'Werewolves' : 'Village';
}

export function campNameShort(team: 'wolf' | 'village', lang: Lang): string {
	if (lang === 'zh') return team === 'wolf' ? '狼人' : '好人';
	return team === 'wolf' ? 'Wolf' : 'Good';
}

// §5.1 预设板子 - keyed by the zh preset name already stored on each
// PresetBoard (src/lib/game/rules/presets.ts), since that's what's actually
// available at the call site (board.name) - not worth threading a separate
// stable id through presets.ts just for this.
const EN_PRESET_NAME: Record<string, string> = {
	'6人新手场': '6-Player Beginner',
	'8人局': '8-Player',
	'9人局': '9-Player',
	'12人标准场': '12-Player Standard',
	'12人守卫场': '12-Player Guard',
	'12人狼王守卫场': '12-Player Wolf King + Guard',
	'12人情侣场': '12-Player Lovers'
};

export function presetName(zhName: string, lang: Lang): string {
	return lang === 'zh' ? zhName : (EN_PRESET_NAME[zhName] ?? zhName);
}
