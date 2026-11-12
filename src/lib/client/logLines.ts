// Diary and room-log lines are stored as data - which line, with what
// numbers - and turned into text only when shown, in the viewer's current
// language. Stored text would freeze in whatever language was on when the
// event arrived (and the diary is kept across reloads).

import type { RoleId } from '$lib/game/types';
import type { PhaseGroup, Winner } from '$lib/shared/gameTypes';
import {
	strings,
	roleName,
	formatNightDeaths,
	formatDayResult,
	formatHunterResult,
	formatGameOverText,
	formatSelfExplode,
	formatDayOut,
	formatKnightDuel,
	formatHostOverrideApplied,
	formatSeerResult,
	formatCoupleRevealed,
	formatRolesReshuffled,
	formatHunterDenied,
	formatShotStatus,
	formatRoomClosedByHost,
	formatPlayerLeftMidGame,
	seatLabel,
	type Lang,
	type Strings
} from '$lib/shared/i18n';

type Param = number | string | boolean | null;

const LINES = {
	/** Any string-table entry: `section.name`, called with `params` if it's
	 * a function. */
	text: (lang: Lang, section: keyof Strings, name: string, ...params: Param[]) => {
		const value = (strings(lang)[section] as Record<string, unknown>)[name];
		return typeof value === 'function' ? value(...params) : String(value);
	},
	nightDeaths: (lang: Lang, deaths: number[]) => formatNightDeaths(deaths, lang),
	dayResult: (lang: Lang, result: Omit<Parameters<typeof formatDayResult>[0], 'lang'>) =>
		formatDayResult({ ...result, lang }),
	hunterResult: (lang: Lang, result: Omit<Parameters<typeof formatHunterResult>[0], 'lang'>) =>
		formatHunterResult({ ...result, lang }),
	gameOver: (lang: Lang, winner: Winner) => formatGameOverText(winner, lang, false),
	selfExplode: (lang: Lang, seat: number) => formatSelfExplode(seat, lang),
	dayOut: (lang: Lang, seats: number[], followDeaths: number[]) =>
		formatDayOut(seats, followDeaths, lang),
	knightDuel: (lang: Lang, knightSeat: number, targetSeat: number, targetWasWolf: boolean) =>
		formatKnightDuel(knightSeat, targetSeat, targetWasWolf, lang),
	hostOverride: (lang: Lang, seat: number, kind: 'KILL' | 'REVIVE' | 'SET_ROLE') =>
		formatHostOverrideApplied(seat, kind, lang),
	seerResult: (lang: Lang, seat: number, isWolf: boolean) => formatSeerResult(seat, isWolf, lang),
	coupleRevealed: (lang: Lang, partnerSeat: number) => formatCoupleRevealed(partnerSeat, lang),
	rolesReshuffled: (lang: Lang, reason?: 'seen_role_left') => formatRolesReshuffled(lang, reason),
	hunterDenied: (lang: Lang) => formatHunterDenied(lang),
	shotStatus: (lang: Lang, canShoot: boolean) => formatShotStatus(canShoot, lang),
	roomClosedByHost: (lang: Lang) => formatRoomClosedByHost(lang),
	playerLeftMidGame: (lang: Lang, seat: number | null) => formatPlayerLeftMidGame(seat, lang),
	/** A wolf's living teammates, as their kill turn last showed them. */
	wolfTeammates: (lang: Lang, seats: number[]) =>
		strings(lang).nightPrompt.wolfTeammates(
			seats.map((s) => seatLabel(s, lang)).join(lang === 'zh' ? '、' : ', ')
		),
	/** The witch's night in one line: what she saved and/or poisoned. */
	witchNight: (lang: Lang, saved: number | null, poisoned: number | null) => {
		const t = strings(lang).nightPrompt;
		const parts = [
			saved !== null ? t.descWitchSaved(saved) : null,
			poisoned !== null ? t.descWitchPoisoned(poisoned) : null
		].filter(Boolean);
		return parts.join(lang === 'zh' ? '，' : '; ') || t.descWitchNoAction;
	},
	/** The thief's pick: kept their card (null) or took `newRole`. */
	thiefNight: (lang: Lang, newRole: RoleId | null) => {
		const t = strings(lang).nightPrompt;
		return newRole === null ? t.descThiefKept : t.descThiefSwapped(roleName(newRole, lang));
	}
};

type Lines = typeof LINES;
type LineKey = keyof Lines;
type LineArgs<K extends LineKey> = Lines[K] extends (lang: Lang, ...args: infer A) => string
	? A
	: never;

export type LogLine = { [K in LineKey]: { key: K; args: LineArgs<K> } }[LineKey];

export function line<K extends LineKey>(key: K, ...args: LineArgs<K>): LogLine {
	return { key, args } as unknown as LogLine;
}

export function renderLine(entry: LogLine, lang: Lang): string {
	const render = LINES[entry.key] as (lang: Lang, ...args: unknown[]) => string;
	return render(lang, ...(entry.args as unknown[]));
}

/** Whether a stored value is a line this version can render - a diary saved
 * by an older version (finished text, or a key since removed) is not. */
export function isLogLine(value: unknown): value is LogLine {
	const v = value as { key?: unknown; args?: unknown } | null;
	return !!v && typeof v.key === 'string' && v.key in LINES && Array.isArray(v.args);
}

/** When in the game a line was logged - rendered with the rest. */
export type Round = { group: PhaseGroup | null; n: number };

export function renderRound(round: Round, lang: Lang): string {
	const t = strings(lang).phaseBanner;
	switch (round.group) {
		case 'night':
			return t.night(round.n);
		case 'vote':
		case 'hunter':
			return lang === 'zh' ? `第 ${round.n} 天` : `Day ${round.n}`;
		case 'over':
			return t.gameOver;
		default:
			return '';
	}
}
