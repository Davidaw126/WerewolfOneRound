// The game store's per-phone view - what this phone may see and do right
// now - tested through the store itself, no browser needed.
import { describe, it, expect } from 'vitest';
import { GameStore } from './gameStore.svelte';
import { renderLine, renderRound } from './logLines';
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
		phase: 'VOTE',
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
			phase: 'NIGHT',
			hostStage: { kind: 'ROLE_TURN', role: 'SEER' }
		});
		expect(phoneOf('host', night).needsHostAdvance).toBe(true);
		expect(phoneOf('s1', night).needsHostAdvance).toBe(false);
		expect(phoneOf('host', room({ phase: 'NIGHT' })).needsHostAdvance).toBe(false);
	});

	it("a seer can't check themselves, except in the pack's kill turn", () => {
		const store = phoneOf('s1', room({ phase: 'NIGHT' }));
		store.myTurnRole = 'SEER';
		store.turnContext = { seat: 1 };
		expect(store.turnRules.noSelfPick).toBe(true);
		store.myTurnRole = 'WOLF_BEAUTY';
		store.turnContext = { seat: 1, packKill: true };
		expect(store.turnRules.noSelfPick).toBe(false);
	});

	it('a witch attacked tonight can only save herself if the rules allow it', () => {
		const store = phoneOf('s4', room({ phase: 'NIGHT' }));
		store.myTurnRole = 'WITCH';
		const witch = { killedSeat: 4, antidoteAvailable: true, poisonAvailable: true };
		store.turnContext = { seat: 4, witch };
		expect(store.turnRules.isSelfKill).toBe(true);
		store.turnContext = { seat: 4, witch: { ...witch, selfRescueAllowed: true } };
		expect(store.turnRules.isSelfKill).toBe(false);
		expect(store.turnRules.onePotionOnly).toBe(true);
	});
});

describe('dawn', () => {
	it('is waiting for the Host to announce exactly while the phase is DAWN', () => {
		expect(phoneOf('s1', room({ phase: 'DAWN' })).awaitingNightAnnounce).toBe(true);
		expect(phoneOf('s1', room({ phase: 'NIGHT' })).awaitingNightAnnounce).toBe(false);
		expect(phoneOf('s1', room({ phase: 'DISCUSSION' })).awaitingNightAnnounce).toBe(false);
	});
});

describe('time of day', () => {
	it('follows the phase, and the winner once the game is over', () => {
		expect(phoneOf('s1', room({ phase: 'SEATING' })).timeOfDay).toBe('neutral');
		expect(phoneOf('s1', room({ phase: 'NIGHT' })).timeOfDay).toBe('night');
		expect(phoneOf('s1', room({ phase: 'DAWN' })).timeOfDay).toBe('night');
		expect(phoneOf('s1', room({ phase: 'VOTE_PK' })).timeOfDay).toBe('day');
		expect(phoneOf('s1', room({ phase: 'DISCUSSION' })).timeOfDay).toBe('day');
		expect(phoneOf('s1', room({ phase: 'GAME_OVER', winner: 'lovers' })).timeOfDay).toBe('lovers');
	});
});

describe('events', () => {
	it('takes who is dead and who flipped from the server, both ways (上帝之手 REVIVE)', () => {
		const store = phoneOf('s1', room());
		store.applyServerEvent({ kind: 'DeathsUpdated', deadSeats: [2, 4], revealedIdiots: [3] });
		expect(store.state?.seats.map((s) => [s.isDead, !!s.revealedIdiot])).toEqual([
			[false, false],
			[true, false],
			[false, true],
			[true, false]
		]);
		store.applyServerEvent({ kind: 'DeathsUpdated', deadSeats: [4], revealedIdiots: [3] });
		expect(store.state?.deadSeats).toEqual([4]);
		expect(store.state?.seats[1].isDead).toBe(false);
	});

	it('night results log one public line, in either language', () => {
		const store = phoneOf('s1', room({ phase: 'DAWN' }));
		store.applyServerEvent({ kind: 'NightResolved', nightNumber: 1, deaths: [2] });
		expect(store.activityLog).toHaveLength(1);
		expect(store.roomLog).toHaveLength(1);
		const [entry] = store.activityLog;
		expect(entry.public).toBe(true);
		// Stored as data, so the same entry reads in whichever language is on.
		expect(renderLine(entry.line, 'zh')).toContain('2');
		expect(renderLine(entry.line, 'zh')).not.toBe(renderLine(entry.line, 'en'));
		expect(renderRound(entry.round, 'en')).toBe('Night 1');
	});

	it("a seer's result goes into their own diary only, not the room log", () => {
		const store = phoneOf('s3', room({ phase: 'NIGHT' }));
		store.applyPrivateEvent({ kind: 'SeerResult', targetSeat: 1, isWolf: true });
		expect(store.lastSeerResult).toEqual({ targetSeat: 1, isWolf: true });
		expect(store.activityLog.map((e) => e.public)).toEqual([false]);
		expect(store.roomLog).toEqual([]);
	});

	it('a new stage clears the last turn and the 情侣相认 tap', () => {
		const store = phoneOf('s1', room({ phase: 'NIGHT' }));
		store.myTurnRole = 'SEER';
		store.coupleConfirmed = true;
		store.applyServerEvent({ kind: 'StageChanged', stage: { kind: 'ROLE_TURN' } });
		expect(store.myTurnRole).toBeNull();
		expect(store.coupleConfirmed).toBe(false);
	});

	it('the end of the game records the winner', () => {
		const store = phoneOf('s1', room({ phase: 'VOTE' }));
		store.applyServerEvent({
			kind: 'GameOver',
			winner: 'wolves',
			identities: { 1: 'WEREWOLF' },
			coupleSeats: null
		});
		expect(store.state?.phase).toBe('GAME_OVER');
		expect(store.timeOfDay).toBe('wolves');
		expect(store.roomLog.at(-1)?.line).toEqual({ key: 'gameOver', args: ['wolves'] });
	});
});
