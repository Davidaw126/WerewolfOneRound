// What the Host's phone says as the game moves - a pure function of how the
// game looked before and after.
import { describe, it, expect } from 'vitest';
import { cuesFor, QUIET, type VoiceView } from './narrationCues';
import { en } from '$lib/shared/i18n/en';

const t = en.narration;
const view = (v: Partial<VoiceView>): VoiceView => ({ ...QUIET, ...v });
const said = (before: VoiceView, now: VoiceView) =>
	cuesFor(before, now, 'en').flatMap((c) => (c.kind === 'say' ? [c.text] : []));

describe('narration cues', () => {
	it('nothing changed, nothing said', () => {
		const v = view({ phase: 'DISCUSSION' });
		expect(cuesFor(v, v, 'en')).toEqual([]);
	});

	it('one batch - a vote result, night falling, the wolves’ turn - is said in that order', () => {
		const before = view({ phase: 'VOTE' });
		const now = view({
			phase: 'NIGHT',
			dayResult: {
				tie: false,
				eliminatedSeat: 3,
				identity: null,
				followDeathSeat: null
			},
			hostStage: { kind: 'ROLE_TURN', role: 'WEREWOLF' }
		});
		const lines = said(before, now);
		expect(lines.slice(1)).toEqual([t.nightBegins, t.wolfTurn]);
		expect(lines[0]).toContain('3');
	});

	it('a role’s call-out tells the server when it starts; other lines don’t', () => {
		const cues = cuesFor(
			view({ phase: 'NIGHT' }),
			view({ phase: 'NIGHT', hostStage: { kind: 'ROLE_TURN', role: 'SEER' } }),
			'en'
		);
		expect(cues).toEqual([
			{ kind: 'drop', tag: 'stage' },
			{ kind: 'say', text: t.seerTurn, tag: 'stage', relay: 'SEER' }
		]);
	});

	it('天亮了 as the night ends, before the deaths are announced', () => {
		const night = view({ phase: 'NIGHT' });
		const dawn = view({ phase: 'DAWN', awaitingNightAnnounce: true });
		expect(said(night, dawn)).toEqual([t.dawnBreaks]);
		const announced = view({ phase: 'DAWN', nightDeaths: [2] });
		expect(said(dawn, announced)).toHaveLength(1);
		expect(said(dawn, announced)[0]).toContain('2');
	});

	it('the lovers’ stage: Cupid closes, everyone looks; leaving it, eyes closed', () => {
		const before = view({ phase: 'NIGHT', hostStage: { kind: 'ROLE_TURN', role: 'CUPID' } });
		const couple = view({ phase: 'NIGHT', hostStage: { kind: 'COUPLE_REVEAL' } });
		expect(said(before, couple)).toEqual([t.cupidClose, t.coupleReveal]);
		const after = view({ phase: 'NIGHT', hostStage: { kind: 'ROLE_TURN', role: 'WEREWOLF' } });
		expect(said(couple, after)).toEqual([t.allEyesClosed, t.wolfTurn]);
	});

	it('back to seating (a stop or 再来一局) cuts everything off', () => {
		expect(cuesFor(view({ phase: 'NIGHT' }), view({ phase: 'SEATING' }), 'en')).toContainEqual({
			kind: 'stop'
		});
	});
});
