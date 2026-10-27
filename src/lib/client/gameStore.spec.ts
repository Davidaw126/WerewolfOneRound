// The game store's per-phone view - what this phone may see and do right
// now - tested through the store itself, no browser needed.
import { describe, it, expect } from 'vitest';
import { GameStore } from './gameStore.svelte';
import type { RoomPublicState, SeatState } from '$lib/shared/gameTypes';

const seat = (n: number, extra: Partial<SeatState> = {}): SeatState => ({
	seatNumber: n,
	sessionId: `s${n}`,
	username: `P${n}`,
	isDead: false,
	...extra
});

function room(overrides: Partial<RoomPublicState> = {}): RoomPublicState {
	return {
		roomCode: '123456',
		phase: 'DAY_VOTE',
		hostUsername: 'Host',
		hostSessionId: 'host',
		roleConfig: {},
		numberOfSeats: 4,
		lockStatus: true,
		nightNumber: 1,
		stage: null,
		seats: [seat(1), seat(2), seat(3), seat(4)],
		deadSeats: [],
		votedSeats: [],
		totalVoters: 4,
		hunterSeat: null,
		currentSpeaker: null,
		speechOrder: [],
		pkCandidates: [],
		winner: null,
		pendingNightAnnounce: false,
		dayDecided: false,
		knightUsed: false,
		...overrides
	} as RoomPublicState;
}

function phoneOf(sessionId: string, state: RoomPublicState): GameStore {
	const store = new GameStore();
	store.viewerSessionId = sessionId;
	store.applyState(state);
	return store;
}

describe('who this phone is', () => {
	it('finds its own seat and knows the Host', () => {
		expect(phoneOf('s3', room()).mySeat).toBe(3);
		expect(phoneOf('s3', room()).isHost).toBe(false);
		const host = phoneOf('host', room());
		expect(host.isHost).toBe(true);
		expect(host.mySeat).toBeNull(); // the Host need not sit
	});

	it('is nobody before the room page says whose phone it is', () => {
		const store = new GameStore();
		store.applyState(room());
		expect(store.mySeat).toBeNull();
		expect(store.isHost).toBe(false);
	});
});

describe('the vote board', () => {
	it('lets a living seated player vote for any living seat', () => {
		const v = phoneOf(
			's1',
			room({ seats: [seat(1), seat(2, { isDead: true }), seat(3)] })
		).voteView;
		expect(v.canVote).toBe(true);
		expect(v.targets.map((s) => s.seatNumber)).toEqual([1, 3]);
	});

	it('locks the vote once cast, for the dead, and for a flipped 白痴', () => {
		expect(phoneOf('s1', room({ votedSeats: [1] })).voteView.canVote).toBe(false);
		expect(phoneOf('s1', room({ seats: [seat(1, { isDead: true })] })).voteView.canVote).toBe(
			false
		);
		const idiot = phoneOf('s1', room({ seats: [seat(1, { revealedIdiot: true }), seat(2)] }));
		expect(idiot.voteView).toMatchObject({ canVote: false, revealedIdiot: true });
	});

	it('in a PK re-vote offers only the tied seats, who do not vote', () => {
		const state = room({ pkCandidates: [2, 3] });
		expect(phoneOf('s1', state).voteView.targets.map((s) => s.seatNumber)).toEqual([2, 3]);
		expect(phoneOf('s2', state).voteView).toMatchObject({ pkCandidate: true, canVote: false });
	});

	it('the Host without a seat sees the board but cannot vote', () => {
		expect(phoneOf('host', room()).voteView.canVote).toBe(false);
	});
});

describe('the night', () => {
	it("shows the Host's 强制继续 on every night stage, and only to the Host", () => {
		const night = room({
			phase: 'NIGHT_ACTIONS',
			hostStage: { kind: 'ROLE_TURN', role: 'SEER' }
		});
		expect(phoneOf('host', night).needsHostAdvance).toBe(true);
		expect(phoneOf('s1', night).needsHostAdvance).toBe(false);
		expect(phoneOf('host', room({ phase: 'NIGHT_ACTIONS' })).needsHostAdvance).toBe(false);
	});

	it("a seer can't check themselves, except in the pack's kill turn", () => {
		const store = phoneOf('s1', room({ phase: 'NIGHT_ACTIONS' }));
		store.myTurnRole = 'SEER';
		store.turnContext = { seat: 1 };
		expect(store.turnRules.noSelfPick).toBe(true);
		store.myTurnRole = 'WOLF_BEAUTY';
		store.turnContext = { seat: 1, packKill: true };
		expect(store.turnRules.noSelfPick).toBe(false);
	});

	it('a witch attacked tonight can only save herself if the rules allow it', () => {
		const store = phoneOf('s4', room({ phase: 'NIGHT_ACTIONS' }));
		store.myTurnRole = 'WITCH';
		const witch = { killedSeat: 4, antidoteAvailable: true, poisonAvailable: true };
		store.turnContext = { seat: 4, witch };
		expect(store.turnRules.isSelfKill).toBe(true);
		store.turnContext = { seat: 4, witch: { ...witch, selfRescueAllowed: true } };
		expect(store.turnRules.isSelfKill).toBe(false);
		expect(store.turnRules.onePotionOnly).toBe(true);
	});
});

describe('time of day', () => {
	it('follows the phase, and the winner once the game is over', () => {
		expect(phoneOf('s1', room({ phase: 'SEATING' })).timeOfDay).toBe('neutral');
		expect(phoneOf('s1', room({ phase: 'NIGHT_ACTIONS' })).timeOfDay).toBe('night');
		expect(phoneOf('s1', room({ phase: 'DISCUSSION' })).timeOfDay).toBe('day');
		expect(phoneOf('s1', room({ phase: 'GAME_OVER', winner: 'lovers' })).timeOfDay).toBe('lovers');
	});
});
