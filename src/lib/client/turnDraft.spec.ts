// The picking rules of each night prompt and the vote, and the submissions
// they make - without a browser.
import { describe, it, expect } from 'vitest';
import {
	PickDraft,
	PotionsDraft,
	LinkDraft,
	ThiefDraft,
	VoteDraft,
	NightDraft,
	type PotionRules
} from './turnDraft.svelte';

const rules =
	(r: Partial<PotionRules> = {}) =>
	() => ({
		killedSeat: 3,
		isSelfKill: false,
		onePotionOnly: true,
		...r
	});

describe('a one-seat pick', () => {
	it('a second tap on the picked seat un-picks it; nothing to send without a seat', () => {
		const d = new PickDraft();
		expect(d.submission('SEER')).toBe(null);
		d.tap(4);
		d.tap(4);
		expect(d.target).toBe(null);
		d.tap(2);
		expect(d.submission('SEER')?.action).toEqual({
			kind: 'NightSubmitAction',
			action: { role: 'SEER', targetSeat: 2 }
		});
	});

	it('空刀 sends no target', () => {
		expect(PickDraft.emptyKill('WEREWOLF').action).toEqual({
			kind: 'NightSubmitAction',
			action: { role: 'WEREWOLF', targetSeat: null }
		});
	});
});

describe('the witch', () => {
	it('with one potion a night, choosing one clears the other, whatever the order', () => {
		const d = new PotionsDraft(rules());
		d.tapPoison(5);
		expect(d.antidoteBlocked).toBe(true);
		d.toggleAntidote();
		expect(d.antidote).toBe(false);
		d.tapPoison(5);
		d.toggleAntidote();
		expect(d.poisonBlocked).toBe(true);
		d.tapPoison(6);
		expect(d.poison).toBe(null);
		expect(d.submission().action).toEqual({
			kind: 'NightSubmitAction',
			action: { role: 'WITCH', poisonTarget: null, useAntidote: true }
		});
	});

	it('when the room allows both potions, both can be chosen', () => {
		const d = new PotionsDraft(rules({ onePotionOnly: false }));
		d.toggleAntidote();
		d.tapPoison(5);
		expect([d.antidote, d.poison]).toEqual([true, 5]);
	});

	it('she can’t save herself when the rules say so', () => {
		const d = new PotionsDraft(rules({ isSelfKill: true }));
		d.toggleAntidote();
		expect(d.antidote).toBe(false);
	});

	it('the diary says who she saved - the night’s victim', () => {
		const d = new PotionsDraft(rules({ killedSeat: 7 }));
		d.toggleAntidote();
		expect(d.submission().entry).toEqual({ key: 'witchNight', args: [7, null] });
	});
});

describe('丘比特', () => {
	it('picks two; with both picked, other taps wait until one is cleared', () => {
		const d = new LinkDraft();
		d.tap(1);
		expect(d.submission()).toBe(null);
		d.tap(2);
		d.tap(3);
		expect([d.first, d.second]).toEqual([1, 2]);
		d.tap(1);
		d.tap(3);
		expect([d.first, d.second]).toEqual([3, 2]);
		expect(d.submission()?.action).toEqual({
			kind: 'NightSubmitAction',
			action: { role: 'CUPID', seatA: 3, seatB: 2 }
		});
	});
});

describe('盗贼', () => {
	it('takes a buried card, or keeps their own', () => {
		const d = new ThiefDraft();
		expect(d.submission(['GUARD', 'CUPID'])).toBe(null);
		d.choose('buried2');
		expect(d.submission(['GUARD', 'CUPID'])).toEqual({
			action: { kind: 'NightSubmitAction', action: { role: 'THIEF', swap: 'buried2' } },
			entry: { key: 'thiefNight', args: ['CUPID'] }
		});
		d.choose('keep');
		expect(d.submission(['GUARD', 'CUPID'])?.action).toEqual({
			kind: 'NightSubmitAction',
			action: { role: 'THIEF', swap: null }
		});
	});
});

describe('a new turn', () => {
	it('starts from a fresh draft', () => {
		const first = new NightDraft(rules());
		first.pick.tap(3);
		first.sent = true;
		const next = new NightDraft(rules());
		expect([next.pick.target, next.sent]).toEqual([null, false]);
	});
});

describe('the vote', () => {
	it('lights the button voted for while the vote counts, and not in the next round', () => {
		const d = new VoteDraft();
		expect(d.submission(4).action).toEqual({ kind: 'VoteCast', target: 4 });
		d.accepted(4);
		expect(d.lit(4, true)).toBe(true);
		expect(d.lit(5, true)).toBe(false);
		// A new round: the server no longer counts this phone as voted.
		expect(d.lit(4, false)).toBe(false);
	});
});
