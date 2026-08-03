import type { Role } from './roles';

export type Phase =
	| 'LOBBY'
	| 'SEATING'
	| 'NIGHT_ACTIONS'
	| 'NIGHT_HUNTER_SHOT'
	| 'DAY_VOTE'
	| 'DAY_HUNTER_SHOT'
	| 'GAME_OVER';

export type NightStage = { kind: 'ROLE_TURN'; role: Role } | { kind: 'COUPLE_REVEAL' };

export interface SeatState {
	seatNumber: number;
	sessionId: string | null;
	username: string | null;
	isDead: boolean;
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
	roleConfig: Partial<Record<Role, number>>;
	numberOfSeats: number;
	lockStatus: boolean;
	nightNumber: number;
	stage: NightStage | null;
	seats: SeatState[];
	deadSeats: number[];
	votes: Record<number, number | 'abstain'>;
	hunterSeat: number | null;
	winner: 'wolves' | 'villagers' | null;
	/** True once the night's deaths have been computed (dead seats are
	 * already marked - voting etc. is never blocked on this) but the host
	 * hasn't yet broadcast the "who died" narration/banner to the table. The
	 * actual death list itself is deliberately NOT part of the public state -
	 * only this boolean - so it can't leak before the host announces it. */
	pendingNightAnnounce: boolean;
	/** Only present once phase === 'GAME_OVER' - the full reveal. */
	identities?: Record<number, Role>;
}
