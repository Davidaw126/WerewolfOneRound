import type { Phase as EnginePhase, RoleId } from '../game/types';

/** The phase on the wire is the engine's own - DAWN (night resolved, the
 * Host hasn't announced yet), VOTE_PK and the rest included. Screens that
 * only care about the broad part of the game use phaseGroup() below. */
export type Phase = EnginePhase;

export type PhaseGroup = 'lobby' | 'seating' | 'night' | 'hunter' | 'speech' | 'vote' | 'over';

export function phaseGroup(phase: Phase): PhaseGroup {
	switch (phase) {
		case 'LOBBY':
			return 'lobby';
		case 'SEATING':
		case 'DEALING':
			return 'seating';
		case 'FIRST_NIGHT':
		case 'NIGHT':
		case 'DAWN':
			return 'night';
		case 'HUNTER_SHOOT':
			return 'hunter';
		case 'LAST_WORDS':
		case 'DISCUSSION':
			return 'speech';
		case 'VOTE':
		case 'VOTE_PK':
		case 'EXILE':
		case 'SHERIFF_ELECTION': // not built yet
			return 'vote';
		case 'GAME_OVER':
			return 'over';
	}
}

/** The room is still being set up and seated - no game state exists yet.
 * Every other phase has one: the IN_PROGRESS_PHASES below, plus GAME_OVER
 * (kept for the final reveal until the next round or the room closes). */
export const PRE_GAME_PHASES: readonly Phase[] = ['LOBBY', 'SEATING'];

/** A round is under way: a non-host leaving now resets the room to SEATING
 * (their seat would otherwise stall the next turn that needs them - a
 * departure during the day used to slip through and freeze the next night).
 * Shared by the server's handleRoomLeave and the client's leave warning. */
export const IN_PROGRESS_PHASES: readonly Phase[] = [
	'FIRST_NIGHT',
	'NIGHT',
	'DAWN',
	'LAST_WORDS',
	'HUNTER_SHOOT',
	'DISCUSSION',
	'VOTE',
	'VOTE_PK',
	'EXILE',
	'SHERIFF_ELECTION'
];

export type NightStage = { kind: 'ROLE_TURN'; role: RoleId } | { kind: 'COUPLE_REVEAL' };

/** S4: the room-wide broadcast form of NightStage - which role is acting is
 * exactly the information a non-actor shouldn't be able to read off the
 * wire, so this drops `role` entirely rather than just hiding it in the UI.
 * The host still needs the real role (to narrate it) - see hostStage below. */
export type PublicNightStage = { kind: 'ROLE_TURN' } | { kind: 'COUPLE_REVEAL' };

/** 'lovers' is a 丘比特-linked couple whose two roles are on DIFFERENT teams
 * (see checkWinWithCouple in winCondition.ts) - an independent third faction
 * excluded from the normal wolves-vs-villagers count, winning only once
 * every other seat is eliminated. */
export type Winner = 'wolves' | 'villagers' | 'lovers';

export interface SeatState {
	seatNumber: number;
	sessionId: string | null;
	username: string | null;
	isDead: boolean;
	/** A 白痴 who flipped after being voted out: alive, still a legal night
	 * target, still speaks, but can no longer vote. Public information. */
	revealedIdiot?: boolean;
}

export interface RoomPublicState {
	roomCode: string;
	phase: Phase;
	hostUsername: string | null;
	/** The host's raw session id - used by the client to determine whether
	 * *it* is the host by comparing against its own sessionId, not by
	 * comparing display names (which two different sessions can share). Not
	 * a secret: it's an opaque id, not a bearer credential - the signed
	 * session cookie is what actually authorizes anything. */
	hostSessionId: string | null;
	roleConfig: Partial<Record<RoleId, number>>;
	numberOfSeats: number;
	lockStatus: boolean;
	nightNumber: number;
	stage: PublicNightStage | null;
	/** Host-only, and only ever present in a payload addressed to the host's
	 * own session (never in the room-wide broadcast) - the real stage,
	 * role included, so JudgeAudioPlayer can narrate it. */
	hostStage?: NightStage | null;
	seats: SeatState[];
	deadSeats: number[];
	/** S11: WHO has voted, never who they voted for or the running tally -
	 * that stays hidden until VoteEnd, so nobody's choice is influenced by
	 * watching others' picks land in real time. */
	votedSeats: number[];
	totalVoters: number;
	hunterSeat: number | null;
	/** LAST_WORDS/DISCUSSION only - whose turn it currently is to speak, null
	 * once the queue is empty (LAST_WORDS) or nobody's left in speechOrder
	 * (DISCUSSION). Not itself sensitive - unlike stage/hostStage, a speaking
	 * order never reveals a role. */
	currentSpeaker: number | null;
	/** DISCUSSION only - the full suggested speaking order (living seats,
	 * ascending). Empty outside DISCUSSION. */
	speechOrder: number[];
	/** VOTE_PK only - the tied seats being re-voted on; empty outside it.
	 * Candidates can't vote (§9.4) and everyone else's vote must target one
	 * of these seats. */
	pkCandidates: number[];
	winner: Winner | null;
	/** Day only: today's outcome is settled (someone exiled, or a
	 * self-explosion / duel ended the day) - only 进入下一夜 is left. */
	dayDecided: boolean;
	/** The 骑士 has dueled (once per game) - public, the duel was announced. */
	knightUsed: boolean;
	/** Identifies the game in progress (its start time), so a phone can tell
	 * whether a diary it saved before a reload belongs to this game. */
	gameId?: string;
	/** Only present once phase === 'GAME_OVER' - the full reveal. */
	identities?: Record<number, RoleId>;
}
