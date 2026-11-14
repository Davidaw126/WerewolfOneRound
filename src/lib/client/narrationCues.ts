// What the Host's phone says, and when: given how the game looked before
// and how it looks now, the lines to queue (and the queue to clear). Pure -
// tested without a browser or a voice (narrationCues.spec.ts). The voice
// itself (queue, unlock, timing) is hostVoice.ts.

import type { RoleId } from '$lib/game/types';
import type { Phase, NightStage, Winner } from '$lib/shared/gameTypes';
import {
	strings,
	formatNightDeaths,
	formatDayResult,
	formatGameOverText,
	type Lang
} from '$lib/shared/i18n';
import { narrationFor } from './roleNight';

/** The parts of the Host's view the voice reacts to. The results are
 * compared by identity: the store sets a new object per event. */
export interface VoiceView {
	phase: Phase | null;
	/** DAWN: the night is over, its deaths not yet announced. */
	awaitingNightAnnounce: boolean;
	/** The real stage (the Host's own channel). */
	hostStage: NightStage | null;
	nightDeaths: number[] | null;
	/** 禁言长老's pick, said with the deaths. */
	silenced?: number | null;
	dayResult: Omit<Parameters<typeof formatDayResult>[0], 'lang'> | null;
	gameOver: { winner: Winner } | null;
}

export const QUIET: VoiceView = {
	phase: null,
	awaitingNightAnnounce: false,
	hostStage: null,
	nightDeaths: null,
	dayResult: null,
	gameOver: null
};

export type Cue =
	/** `relay`: tell the server when this role's call-out starts - every
	 * other phone holds that role's prompt until then. */
	| { kind: 'say'; text: string; tag?: 'stage'; relay?: RoleId }
	/** Drop the still-queued lines of the turn that just ended. */
	| { kind: 'drop'; tag: 'stage' }
	/** Cut everything off (the round was reset). */
	| { kind: 'stop' };

const stageKey = (stage: NightStage | null): string | null =>
	stage ? (stage.kind === 'ROLE_TURN' ? stage.role : 'COUPLE_REVEAL') : null;

/** In order: results first, then the phase line, then the role call-out -
 * one server batch (a vote result, night falling, the first role's turn)
 * often changes several at once, and they must be said in that order. */
export function cuesFor(before: VoiceView, now: VoiceView, lang: Lang): Cue[] {
	const t = strings(lang).narration;
	const cues: Cue[] = [];
	const say = (text: string) => cues.push({ kind: 'say', text });

	if (now.nightDeaths !== before.nightDeaths && now.nightDeaths !== null)
		say(formatNightDeaths(now.nightDeaths, lang, now.silenced ?? null));
	if (now.dayResult !== before.dayResult && now.dayResult)
		say(formatDayResult({ ...now.dayResult, lang }));
	if (now.gameOver !== before.gameOver && now.gameOver)
		say(formatGameOverText(now.gameOver.winner, lang, true));

	if (now.phase && now.phase !== before.phase) {
		if (now.phase === 'FIRST_NIGHT' || now.phase === 'NIGHT') say(t.nightBegins);
		// Stopped or restarted: nothing from the old round may run on.
		if (now.phase === 'LOBBY' || now.phase === 'SEATING') cues.push({ kind: 'stop' });
	}

	// 天亮了 the moment the night ends - before the Host announces who died.
	if (now.awaitingNightAnnounce && !before.awaitingNightAnnounce) say(t.dawnBreaks);

	const key = stageKey(now.hostStage);
	const previousKey = stageKey(before.hostStage);
	if (key !== previousKey) {
		cues.push({ kind: 'drop', tag: 'stage' });
		// The lovers confirm on their own phones, so the closing cue is said
		// on the way out of their stage.
		if (previousKey === 'COUPLE_REVEAL')
			cues.push({ kind: 'say', text: t.allEyesClosed, tag: 'stage' });
		if (key === 'COUPLE_REVEAL') {
			cues.push({ kind: 'say', text: t.cupidClose, tag: 'stage' });
			cues.push({ kind: 'say', text: t.coupleReveal, tag: 'stage' });
		} else if (key) {
			const line = narrationFor(key as RoleId);
			if (line) cues.push({ kind: 'say', text: t[line], tag: 'stage', relay: key as RoleId });
		}
	}
	return cues;
}
