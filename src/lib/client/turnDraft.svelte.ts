// What a player has picked so far on their night turn, or in a vote, before
// confirming: the picking rules (which taps undo, which choices exclude each
// other) and the submission the choice makes. The prompts only draw a draft
// and call it. A new turn gets a new draft, so nothing carries over from the
// last one. Tested without a browser (turnDraft.spec.ts).

import type { RoleId } from '$lib/game/types';
import type { ClientAction, NightActionSubmission } from '$lib/shared/events';
import { line, type LogLine } from './logLines';

/** An action to send, and the diary line it becomes once accepted. */
export interface Submission {
	action: ClientAction;
	entry: LogLine;
}

const nightAction = (action: NightActionSubmission): ClientAction => ({
	kind: 'NightSubmitAction',
	action
});

/** One seat (wolves, seer, guard, the wolf-team skills). Tapping the picked
 * seat again un-picks it. */
export class PickDraft {
	target = $state<number | null>(null);

	tap(seat: number): void {
		this.target = this.target === seat ? null : seat;
	}

	submission(role: RoleId): Submission | null {
		if (this.target === null) return null;
		return {
			action: nightAction({ role, targetSeat: this.target } as NightActionSubmission),
			entry: line('text', 'nightPrompt', 'descSelectedSeat', this.target)
		};
	}

	/** 空刀: the pack kills nobody tonight. */
	static emptyKill(role: RoleId): Submission {
		return {
			action: nightAction({ role, targetSeat: null } as NightActionSubmission),
			entry: line('text', 'nightPrompt', 'descEmptyKill')
		};
	}
}

/** The rules the witch's panel follows tonight (the store's turnRules). */
export interface PotionRules {
	killedSeat: number | null;
	isSelfKill: boolean;
	onePotionOnly: boolean;
}

/** The witch: the antidote on tonight's victim, and/or a poison target. With
 * one potion a night, choosing one clears the other - so no order of taps
 * can build a draft the server would refuse. */
export class PotionsDraft {
	antidote = $state(false);
	poison = $state<number | null>(null);

	constructor(private readonly rules: () => PotionRules) {}

	get antidoteBlocked(): boolean {
		const r = this.rules();
		return r.isSelfKill || (r.onePotionOnly && this.poison !== null);
	}

	get poisonBlocked(): boolean {
		return this.rules().onePotionOnly && this.antidote;
	}

	toggleAntidote(): void {
		if (this.antidoteBlocked && !this.antidote) return;
		this.antidote = !this.antidote;
		if (this.antidote && this.rules().onePotionOnly) this.poison = null;
	}

	tapPoison(seat: number): void {
		if (this.poisonBlocked) return;
		this.poison = this.poison === seat ? null : seat;
		if (this.poison !== null && this.rules().onePotionOnly) this.antidote = false;
	}

	submission(): Submission {
		return {
			action: nightAction({
				role: 'WITCH',
				poisonTarget: this.poison,
				useAntidote: this.antidote
			}),
			entry: line('witchNight', this.antidote ? this.rules().killedSeat : null, this.poison)
		};
	}
}

/** 丘比特: two seats. A tap on a picked seat un-picks it; with both picked,
 * other taps are ignored until one is cleared (never silently replaced). */
export class LinkDraft {
	first = $state<number | null>(null);
	second = $state<number | null>(null);

	has(seat: number): boolean {
		return this.first === seat || this.second === seat;
	}

	tap(seat: number): void {
		if (this.first === seat) this.first = null;
		else if (this.second === seat) this.second = null;
		else if (this.first === null) this.first = seat;
		else if (this.second === null) this.second = seat;
	}

	submission(): Submission | null {
		if (this.first === null || this.second === null) return null;
		return {
			action: nightAction({ role: 'CUPID', seatA: this.first, seatB: this.second }),
			entry: line('text', 'nightPrompt', 'descCupidLinked', this.first, this.second)
		};
	}
}

/** 盗贼: take one of the two buried cards, or keep their own. */
export class ThiefDraft {
	pick = $state<'buried1' | 'buried2' | 'keep' | null>(null);

	choose(pick: 'buried1' | 'buried2' | 'keep'): void {
		this.pick = this.pick === pick ? null : pick;
	}

	submission(buried: readonly [RoleId, RoleId]): Submission | null {
		if (this.pick === null) return null;
		const swap = this.pick === 'keep' ? null : this.pick;
		const taken = swap === null ? null : buried[swap === 'buried1' ? 0 : 1];
		return {
			action: nightAction({ role: 'THIEF', swap }),
			entry: line('thiefNight', taken)
		};
	}
}

/** A night turn's draft, whatever the prompt: a fresh one per turn. */
export class NightDraft {
	/** Sent and waiting on the reply - the prompt shows "close your eyes". */
	sent = $state(false);
	readonly pick = new PickDraft();
	readonly potions: PotionsDraft;
	readonly link = new LinkDraft();
	readonly thief = new ThiefDraft();

	constructor(rules: () => PotionRules) {
		this.potions = new PotionsDraft(rules);
	}

	/** A feared player ends their turn without their skill. */
	static pass(): Submission {
		return {
			action: { kind: 'NightPass' },
			entry: line('text', 'nightPrompt', 'descFearedPassed')
		};
	}
}

/** A vote: who this phone voted for, kept only to keep that button lit.
 * It shows only while the server still counts this phone as having voted,
 * so a new round of voting starts unlit without any reset. */
export class VoteDraft {
	private cast = $state<number | 'abstain' | null>(null);

	submission(target: number | 'abstain'): Submission {
		return {
			action: { kind: 'VoteCast', target },
			entry:
				target === 'abstain'
					? line('text', 'vote', 'myVoteAbstain')
					: line('text', 'vote', 'myVoteFor', target)
		};
	}

	/** The server took this vote. */
	accepted(target: number | 'abstain'): void {
		this.cast = target;
	}

	lit(target: number | 'abstain', alreadyVoted: boolean): boolean {
		return alreadyVoted && this.cast === target;
	}
}
