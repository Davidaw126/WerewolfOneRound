// Dynamic, structured-data-driven sentence builders. Several of these events
// used to be independently phrased in THREE places (JudgeAudioPlayer's TTS
// line, gameStore's activity/room log text, and room/[code]/+page.svelte's
// own on-screen banner) - since none of that duplication was ever meant to
// diverge, translating was a good moment to converge all three onto these
// single shared functions instead of writing (and maintaining) three
// separate English versions of the same sentence.

import type { Lang } from './types';
import type { RoleId } from '../../game/types';
import type { Winner } from '../gameTypes';
import type { ValidationIssue } from '../../game/rules/setup';
import type { NightRuleError } from '../../game/rules/nightRules';
import type { Refusal } from '../events';
import { isValidationCode, type RoomErrorCode } from '../actionErrors';
import { roleName } from './roles';
import { zh } from './zh';
import { en } from './en';

/** "X号" / "Seat X" - the single-seat label used throughout the seat grid,
 * vote board, night prompts, etc. wherever a bare seat number needs to read
 * as a label rather than just a number. */
export function seatLabel(seatNumber: number, lang: Lang): string {
	return lang === 'zh' ? `${seatNumber}号` : `Seat ${seatNumber}`;
}

function joinSeatsZh(seats: number[]): string {
	return seats.join('、');
}

function joinSeatsEn(seats: number[]): string {
	if (seats.length === 1) return `seat ${seats[0]}`;
	if (seats.length === 2) return `seats ${seats[0]} and ${seats[1]}`;
	return `seats ${seats.slice(0, -1).join(', ')}, and ${seats[seats.length - 1]}`;
}

export function formatNightDeaths(deaths: number[], lang: Lang): string {
	if (deaths.length === 0) {
		return lang === 'zh' ? '昨晚是平安夜' : 'It was a peaceful night — no one died.';
	}
	return lang === 'zh'
		? `昨晚 ${joinSeatsZh(deaths)} 号玩家死亡`
		: `Last night, ${joinSeatsEn(deaths)} died.`;
}

function appendFollowDeath(base: string, followDeathSeat: number | null, lang: Lang): string {
	if (followDeathSeat === null) return base;
	return lang === 'zh'
		? `${base}，${followDeathSeat} 号殉情身亡`
		: `${base} Seat ${followDeathSeat} died alongside them, out of love.`;
}

export function formatDayResult(params: {
	tie: boolean;
	eliminatedSeat: number | null;
	identity: RoleId | null;
	followDeathSeat: number | null;
	idiotRevealed?: boolean;
	lang: Lang;
}): string {
	const { tie, eliminatedSeat, identity, followDeathSeat, lang } = params;
	if (params.idiotRevealed && eliminatedSeat !== null) {
		return lang === 'zh'
			? `${eliminatedSeat} 号被放逐，翻牌为白痴，免于出局，之后不能再投票`
			: `Seat ${eliminatedSeat} was exiled but revealed as the Idiot - they stay in the game, but can no longer vote.`;
	}
	// The exiled player's card stays face down - only a role the server
	// chose to make public (none, today) would be named here.
	const roleSuffix = identity
		? lang === 'zh'
			? `，身份是 ${roleName(identity, lang)}`
			: ` Their role was ${roleName(identity, lang)}.`
		: '';
	const base =
		lang === 'zh'
			? tie
				? '投票平票，无人出局'
				: eliminatedSeat === null
					? '本轮无人出局'
					: `${eliminatedSeat} 号被放逐出局${roleSuffix}`
			: tie
				? 'The vote was tied — no one was eliminated.'
				: eliminatedSeat === null
					? 'No one was eliminated this round.'
					: `Seat ${eliminatedSeat} was exiled.${roleSuffix}`;
	return appendFollowDeath(base, followDeathSeat, lang);
}

/** Shared by the hunter and both wolf kings - deliberately role-neutral, so
 * the narration never calls a 黑狼王 "the hunter" out loud. */
export function formatHunterResult(params: {
	hunterSeat: number;
	shotSeat: number | null;
	followDeathSeat: number | null;
	lang: Lang;
}): string {
	const { hunterSeat, shotSeat, followDeathSeat, lang } = params;
	const base =
		lang === 'zh'
			? shotSeat === null
				? `${hunterSeat} 号选择不开枪`
				: `${hunterSeat} 号开枪，带走了 ${shotSeat} 号玩家`
			: shotSeat === null
				? `Seat ${hunterSeat} chose not to shoot.`
				: `Seat ${hunterSeat} shot and took seat ${shotSeat} down with them.`;
	return appendFollowDeath(base, followDeathSeat, lang);
}

export function formatGameOverText(
	winner: Winner,
	lang: Lang,
	withGameOverSuffix: boolean
): string {
	const zh =
		winner === 'wolves' ? '狼人阵营胜利' : winner === 'lovers' ? '第三方阵营胜利' : '好人阵营胜利';
	const en =
		winner === 'wolves'
			? 'The Werewolves Win'
			: winner === 'lovers'
				? 'The Lovers Win'
				: 'The Village Wins';
	if (!withGameOverSuffix) return lang === 'zh' ? zh : en;
	return lang === 'zh' ? `${zh}，游戏结束` : `${en} — Game Over`;
}

export function formatDayOut(seats: number[], followDeaths: number[], lang: Lang): string {
	const out = lang === 'zh' ? `${seats.join('、')} 号出局` : `Seat ${seats.join(', ')} out`;
	if (followDeaths.length === 0) return out;
	return lang === 'zh'
		? `${out}，${followDeaths.join('、')} 号随之出局`
		: `${out}; seat ${followDeaths.join(', ')} also leaves`;
}

export function formatSelfExplode(seat: number, lang: Lang): string {
	return lang === 'zh'
		? `${seat} 号玩家自爆身份为狼人`
		: `Seat ${seat} self-destructed as a Werewolf`;
}

export function formatKnightDuel(
	knightSeat: number,
	targetSeat: number,
	targetWasWolf: boolean,
	lang: Lang
): string {
	if (lang === 'zh') {
		return targetWasWolf
			? `骑士 ${knightSeat} 号决斗 ${targetSeat} 号，对方是狼人，${targetSeat} 号出局`
			: `骑士 ${knightSeat} 号决斗 ${targetSeat} 号，对方是好人，骑士出局`;
	}
	return targetWasWolf
		? `The Knight (seat ${knightSeat}) dueled seat ${targetSeat} — they were a werewolf, and seat ${targetSeat} is out.`
		: `The Knight (seat ${knightSeat}) dueled seat ${targetSeat} — they were good, and the Knight is out.`;
}

const HOST_OVERRIDE_LABEL: Record<Lang, Record<'KILL' | 'REVIVE' | 'SET_ROLE', string>> = {
	zh: { KILL: '击杀', REVIVE: '复活', SET_ROLE: '改变身份' },
	en: { KILL: 'kill', REVIVE: 'revive', SET_ROLE: 'role change' }
};

export function formatHostOverrideApplied(
	seat: number,
	overrideKind: 'KILL' | 'REVIVE' | 'SET_ROLE',
	lang: Lang
): string {
	const label = HOST_OVERRIDE_LABEL[lang][overrideKind];
	return lang === 'zh'
		? `房主使用上帝之手对 ${seat} 号${label}`
		: `The host used God Mode on seat ${seat}: ${label}`;
}

export function formatSeerResult(seat: number, isWolf: boolean, lang: Lang): string {
	return lang === 'zh'
		? `你查验了 ${seat} 号，结果是${isWolf ? '坏人' : '好人'}`
		: `You checked seat ${seat} — the result is ${isWolf ? 'Evil' : 'Good'}`;
}

export function formatCoupleRevealed(partnerSeat: number, lang: Lang): string {
	return lang === 'zh' ? `你的情侣是 ${partnerSeat} 号` : `Your lover is seat ${partnerSeat}`;
}

export function formatRolesReshuffled(lang: Lang, reason?: 'seen_role_left'): string {
	if (reason === 'seen_role_left')
		return lang === 'zh'
			? '有玩家看过身份后离开，角色已重新分配'
			: 'A player left after seeing their role, so roles were reshuffled';
	return lang === 'zh' ? '房主重新分配了角色' : 'The host reshuffled everyone’s roles';
}

export function formatRolesReshuffledConfirm(lang: Lang): string {
	return lang === 'zh' ? '✓ 角色已重新分配' : '✓ Roles reshuffled';
}

/** The popup text for a refused action. A setup refusal is told from its
 * first issue, with that issue's own numbers. */
export function formatRefusal(refusal: Refusal, lang: Lang): string {
	const t = lang === 'zh' ? zh : en;
	const issue = refusal.issues?.[0];
	if (issue) return formatSetupIssue(issue, lang);
	const code = refusal.error;
	if (isValidationCode(code)) return formatSetupIssue({ code }, lang);
	if (code in t.nightPrompt.ruleMessages) return t.nightPrompt.ruleMessages[code as NightRuleError];
	// `fallback`: a code from a newer server than this page.
	return t.errors[code as RoomErrorCode] ?? t.errors.fallback;
}

export function formatHunterDenied(lang: Lang): string {
	return lang === 'zh' ? '你身中剧毒，无法开枪反击' : "You're poisoned and can't shoot back";
}

export function formatShotStatus(canShoot: boolean, lang: Lang): string {
	if (lang === 'zh')
		return canShoot ? '你出局了，可以开枪：在桌上亮牌并指定带走的人' : '你出局了，这次不能开枪';
	return canShoot
		? "You're out and may shoot: show your card at the table and name your target"
		: "You're out and can't shoot this time";
}

export function formatHunterAuthorized(lang: Lang): string {
	return lang === 'zh' ? '你可以开枪反击' : 'You may shoot back';
}

export function formatRoomClosedByHost(lang: Lang): string {
	return lang === 'zh' ? '房主已离开，房间已关闭' : 'The host left — the room has been closed';
}

export function formatPlayerLeftMidGame(leavingSeat: number | null, lang: Lang): string {
	if (lang === 'zh') {
		return leavingSeat !== null
			? `${leavingSeat} 号玩家离开了房间，当前对局已结束`
			: '有玩家离开了房间，当前对局已结束';
	}
	return leavingSeat !== null
		? `Seat ${leavingSeat} left the room — the current round has ended`
		: 'A player left the room — the current round has ended';
}

// §5.2 validateSetup's E01-E09 codes - the server sends {code, params} rather
// than a baked message (see game/rules/setup.ts) specifically so this stays a
// client-only rendering concern, matching every other error-code mapping in
// the app instead of being the one exception that could only ever speak
// Chinese.
export function formatSetupIssue(issue: ValidationIssue, lang: Lang): string {
	const { code, reason } = issue;
	const params = issue.params ?? {};
	const roleLabel = params.roleId ? roleName(params.roleId, lang) : '';
	if (lang === 'zh') {
		switch (code) {
			case 'E01':
				return `角色总数（${params.numberOfSeats}）与玩家数（${params.playerCount}）不一致，请检查是否所有座位都已入座`;
			case 'E02':
				return '狼人阵营至少需要 1 人';
			case 'E03':
				return '好人阵营至少需要 1 人';
			case 'E04':
				return '狼人数必须少于好人数，否则一开局狼人就已经获胜';
			case 'E05':
				return reason === 'negative'
					? `${roleLabel} 数量不能为负数`
					: `${roleLabel} 是唯一角色，数量不能超过 1`;
			case 'E07':
				return '配置了野孩子时，玩家数至少需要 4 人';
			case 'E08':
				return '配置了丘比特时，玩家数至少需要 6 人';
			case 'E09':
				return '骑士与白痴同时在场，节奏可能偏慢，请知悉';
			default:
				return code;
		}
	}
	switch (code) {
		case 'E01':
			return `Total roles (${params.numberOfSeats}) doesn't match the number of players (${params.playerCount}) — check that every seat is filled`;
		case 'E02':
			return 'The wolf team needs at least 1 player';
		case 'E03':
			return 'The good team needs at least 1 player';
		case 'E04':
			return 'Wolves must outnumber the good team, or the wolves would win instantly';
		case 'E05':
			return reason === 'negative'
				? `${roleLabel} count can't be negative`
				: `${roleLabel} is a unique role — count can't exceed 1`;
		case 'E07':
			return 'Wild Child requires at least 4 players';
		case 'E08':
			return 'Cupid requires at least 6 players';
		case 'E09':
			return 'Knight and Idiot together may slow the game down — just a heads up';
		default:
			return code;
	}
}
