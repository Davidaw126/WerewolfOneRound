import { roleTeam, type Role } from './roles';
import type { RoleId } from '../game/types';
import { roleIdToLegacy } from '../game/roleBridge';

// Hand-authored 16x16 pixel sprites. Each sprite is 16 rows of chars; each char
// indexes PAL (space/'.' = transparent). Rendered crisp+scaled by PixelSprite.
// Faction-shared busts cover the plain roles (like the real card game); power
// roles get distinct art. Structured behind ROLE_ART so real raster art can
// replace these later with no other change.

export const PAL: Record<string, string | null> = {
	'.': null,
	k: '#0b0b12', // outline
	r: '#e03131', // wolf red
	R: '#7f1d1d', // deep red
	g: '#f2c14e', // village gold
	y: '#b8902f', // gold shadow
	o: '#f59e0b', // ember
	s: '#f0c8a0', // skin
	S: '#c07a4e', // skin shadow
	p: '#b8a1ff', // lavender
	P: '#6c4fd0', // deep purple
	c: '#8ec7ff', // cyan
	C: '#3f7fd0', // deep cyan
	w: '#f4f0e6', // bone/white
	n: '#2a2c44', // night
	b: '#7a5230', // brown
	B: '#4a3320', // dark brown
	e: '#6ab04c', // green
	h: '#d94f8f' // pink
};

// Shared character "bust": head + shoulders. Vary hat/cloth/accent/eye per role.
function bust(opt: { hat: string; cloth: string; accent?: string; eye?: string }): string[] {
	const H = opt.hat;
	const C = opt.cloth;
	const A = opt.accent ?? C;
	const E = opt.eye ?? 'k';
	return [
		'................',
		'................',
		'....' + H.repeat(8) + '....',
		'...' + H.repeat(10) + '...',
		'...k' + 'ssssssss' + 'k...',
		'...k' + 's' + E + 'ss' + 'ss' + E + 's' + 'k...',
		'...k' + 'ssssssss' + 'k...',
		'...k' + 'S' + 'ssssss' + 'S' + 'k...',
		'....k' + 'ssssss' + 'k....',
		'..k' + C.repeat(10) + 'k..',
		'..k' + C.repeat(10) + 'k..',
		'..k' + C + A.repeat(8) + C + 'k..',
		'..k' + C.repeat(10) + 'k..',
		'..k' + C.repeat(10) + 'k..',
		'..k' + C + C + 'kk....' + C + C + 'k..',
		'...kk......kk...'
	];
}

const WOLF: string[] = [
	'................',
	'..k..........k..',
	'..kk........kk..',
	'.kkkk......kkkk.',
	'.kkkkkkkkkkkkkk.',
	'.kkkkkkkkkkkkkk.',
	'.kkrwkkkkkkwrkk.',
	'.kkkkkkkkkkkkkk.',
	'..kkkwwwwwwkkk..',
	'..kkwwwwwwwwkk..',
	'..kkwkwwwwkwkk..',
	'...kkwwwwwwkk...',
	'...kkkwwwwkkk...',
	'....kwkwwkwk....',
	'.....kkkkkk.....',
	'................'
];

function crownedWolf(crown: string): string[] {
	const g = WOLF.slice();
	g[1] = '..' + crown + 'k.' + crown + '.' + crown + '.' + crown + '.k' + crown + '..';
	g[2] = '..kk.' + crown.repeat(5) + '.kk..';
	g[3] = '.kkkk' + crown.repeat(5) + 'kkkk.';
	return g;
}

// Distinct art for the notable roles; everything else falls back by faction.
const ART: Partial<Record<Role, string[]>> = {
	普通村民: bust({ hat: 'b', cloth: 'b', accent: 'y' }),
	高级村民: bust({ hat: 'b', cloth: 'B', accent: 'g' }),
	老流氓: bust({ hat: 'B', cloth: 'n', accent: 'b' }),
	预言家: bust({ hat: 'P', cloth: 'P', accent: 'c', eye: 'c' }),
	女巫: bust({ hat: 'P', cloth: 'P', accent: 'e' }),
	猎人: bust({ hat: 'B', cloth: 'g', accent: 'k' }),
	守卫: bust({ hat: 'c', cloth: 'C', accent: 'w' }),
	骑士: bust({ hat: 'c', cloth: 'c', accent: 'w' }),
	丘比特: bust({ hat: 'h', cloth: 'w', accent: 'h' }),
	白痴: bust({ hat: 'b', cloth: 'e', accent: 'g' }),
	禁言长老: bust({ hat: 'w', cloth: 'n', accent: 'w' }),
	摄梦人: bust({ hat: 'P', cloth: 'n', accent: 'p' }),
	野孩子: bust({ hat: 'b', cloth: 'e', accent: 'b' }),
	盗贼: bust({ hat: 'k', cloth: 'n', accent: 'g' }),

	普通狼人: WOLF,
	机械狼: bust({ hat: 'k', cloth: 'n', accent: 'c', eye: 'r' }),
	狼美人: bust({ hat: 'k', cloth: 'r', accent: 'h', eye: 'r' }),
	隐狼: bust({ hat: 'k', cloth: 'R', accent: 'r', eye: 'r' }),
	恶魔: bust({ hat: 'r', cloth: 'R', accent: 'k', eye: 'w' }),
	恶灵骑士: bust({ hat: 'k', cloth: 'R', accent: 'c', eye: 'r' }),
	梦魇: bust({ hat: 'P', cloth: 'R', accent: 'r', eye: 'r' }),
	白狼王: crownedWolf('g'),
	黑狼王: crownedWolf('k')
};

const GENERIC_VILLAGER = bust({ hat: 'b', cloth: 'b', accent: 'y' });

export function spriteFor(role: RoleId): string[] {
	return ART[roleIdToLegacy(role)] ?? (roleTeam(role) === 'wolf' ? WOLF : GENERIC_VILLAGER);
}
