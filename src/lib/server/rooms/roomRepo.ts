import { redis } from '../redis';
import { getSession } from '../session';
import { TAKE_SEAT_LUA, LEAVE_SEAT_LUA, SUBMIT_ROOM_CONFIG_LUA } from './lua/scripts';
import {
	ROOM_TTL_SECONDS,
	roomKey,
	seatsKey,
	playersKey,
	identitiesKey,
	deadSeatsKey,
	votesKey,
	coupleSeatsKey,
	revealedKey,
	fixedRoomKeys
} from './keys';
import type { Role } from '../../shared/roles';
import type { Phase, RoomPublicState, SeatState } from '../../shared/gameTypes';
import type { DealResult } from '../../shared/deal';
import type { RuleConfigOverrides } from '../../game/defaultRuleConfig';
import { loadGameState } from '../game/gameStateRepo';
import {
	mapToLegacyPhase,
	stageOf,
	toPublicStage,
	deadSeatsOf,
	votedSeatsOf,
	totalVotersOf,
	hunterSeatOf,
	currentSpeakerOf,
	speechOrderOf,
	pkCandidatesOf,
	winnerOf,
	identitiesOf
} from '../game/projection';

declare module 'ioredis' {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars -- required to match ioredis's declaration-merge signature
	interface RedisCommander<Context> {
		takeSeat(
			seatsKey: string,
			playersKey: string,
			identitiesKey: string,
			roomKey: string,
			sessionId: string,
			newSeat: string,
			username: string,
			ttl: number
		): Promise<string>;
		leaveSeat(seatsKey: string, playersKey: string, sessionId: string): Promise<string>;
		submitRoomConfig(
			roomKey: string,
			identitiesKey: string,
			seatsKey: string,
			deadSeatsKey: string,
			votesKey: string,
			coupleSeatsKey: string,
			revealedKey: string,
			sessionId: string,
			roleConfigJson: string,
			numberOfSeats: string,
			identitiesJson: string,
			ttl: number,
			cupidPoisonBlocksHunter: string
		): Promise<string>;
	}
}

redis.defineCommand('takeSeat', { numberOfKeys: 4, lua: TAKE_SEAT_LUA });
redis.defineCommand('leaveSeat', { numberOfKeys: 2, lua: LEAVE_SEAT_LUA });
redis.defineCommand('submitRoomConfig', { numberOfKeys: 7, lua: SUBMIT_ROOM_CONFIG_LUA });

// M1: everything about "what stage/round/death-list/hunter-shot is in
// progress" moved into the new engine's own GameState blob (gameStateRepo.ts) -
// the room hash keeps only the RoomManager-scope fields (seat/config/lobby
// lifecycle) plus `phase`/`nightNumber`, kept in sync with GameState by
// gameSync.ts purely so phase-gated logic elsewhere (handleRoomLeave's
// IN_PROGRESS_PHASES check, requireHost, etc.) doesn't need to know the new
// engine exists at all.
export interface RoomHashData {
	phase: Phase;
	hostSessionId: string;
	roleConfig: Partial<Record<Role, number>>;
	numberOfSeats: number;
	lockStatus: boolean;
	nightNumber: number;
	/** House rule captured at RoomSubmitConfig time (before seating even
	 * starts) and folded into the engine's RuleConfig at RoomStartGame time -
	 * one of two pieces of pre-game config that aren't themselves a role
	 * count (the other being ruleOverrides, below). */
	cupidPoisonBlocksHunter: boolean;
	/** M2's host-facing RuleConfig switches (§6), captured at RoomSubmitConfig
	 * time the same way roleConfig is, and merged onto defaultRuleConfig() at
	 * RoomStartGame time - see game/defaultRuleConfig.ts's mergeRuleConfig. */
	ruleOverrides: RuleConfigOverrides;
}

export async function readRoomHash(code: string): Promise<RoomHashData | null> {
	const data = await redis.hgetall(roomKey(code));
	if (!data.phase) return null;
	return {
		phase: (data.phase || 'LOBBY') as Phase,
		hostSessionId: data.hostSessionId || '',
		roleConfig: data.roleConfig ? JSON.parse(data.roleConfig) : {},
		numberOfSeats: Number(data.numberOfSeats || 0),
		lockStatus: data.lockStatus === '1',
		nightNumber: Number(data.nightNumber || 0),
		cupidPoisonBlocksHunter: data.cupidPoisonBlocksHunter === '1',
		ruleOverrides: data.ruleOverrides ? JSON.parse(data.ruleOverrides) : {}
	};
}

export async function roomExists(code: string): Promise<boolean> {
	return (await redis.exists(roomKey(code))) === 1;
}

/** hostSessionId is assigned immediately to whoever creates the room, not
 * whoever happens to submit the config first - a friend who joins via the
 * room code before the creator finishes setting up roles should see a
 * waiting message, not the config form itself (and definitely shouldn't be
 * able to submit config out from under the actual host). */
export async function createRoom(code: string, hostSessionId: string): Promise<void> {
	await redis.hset(roomKey(code), {
		phase: 'LOBBY',
		roleConfig: '{}',
		numberOfSeats: '0',
		hostSessionId
	});
	await redis.expire(roomKey(code), ROOM_TTL_SECONDS);
}

export async function getPlayers(
	code: string
): Promise<Record<string, { username: string; seat: number | null }>> {
	const raw = await redis.hgetall(playersKey(code));
	const out: Record<string, { username: string; seat: number | null }> = {};
	for (const [sessionId, json] of Object.entries(raw)) {
		out[sessionId] = JSON.parse(json);
	}
	return out;
}

export async function getSeats(code: string): Promise<Record<string, string>> {
	return redis.hgetall(seatsKey(code));
}

export async function getIdentities(code: string): Promise<Record<string, Role>> {
	return (await redis.hgetall(identitiesKey(code))) as Record<string, Role>;
}

/** Which seat (if any) the given session currently occupies. */
export async function seatOf(code: string, sessionId: string): Promise<number | null> {
	const players = await getPlayers(code);
	return players[sessionId]?.seat ?? null;
}

export async function findSessionInSeat(code: string, seat: number): Promise<string | null> {
	const seats = await getSeats(code);
	return seats[String(seat)] ?? null;
}

export async function hasRevealed(code: string, sessionId: string): Promise<boolean> {
	return (await redis.sismember(revealedKey(code), sessionId)) === 1;
}

export async function markRevealed(code: string, sessionId: string): Promise<void> {
	await redis.sadd(revealedKey(code), sessionId);
	await redis.expire(revealedKey(code), ROOM_TTL_SECONDS);
}

/** If this session has already tapped "reveal" for their current role, look
 * it up again (e.g. to replay it on reconnect) - otherwise null, so a client
 * that has never revealed isn't shown one unprompted. */
export async function getRevealedRoleIfAny(code: string, sessionId: string): Promise<Role | null> {
	if (!(await hasRevealed(code, sessionId))) return null;
	const seat = await seatOf(code, sessionId);
	if (seat === null) return null;
	const identities = await getIdentities(code);
	return identities[String(seat)] ?? null;
}

const IN_GAME_PHASES: Phase[] = [
	'NIGHT_ACTIONS',
	'NIGHT_HUNTER_SHOT',
	'LAST_WORDS',
	'DISCUSSION',
	'DAY_VOTE',
	'DAY_HUNTER_SHOT',
	'GAME_OVER'
];

/** Assembles the full public state, e.g. for StateSnapshot/ResyncRequest.
 * Pre-game (LOBBY/SEATING) fields come from the RoomManager-scope keys, same
 * as always; once a game is in progress, the game-specific fields (stage,
 * deaths, votes, hunter, winner, identities) are projected fresh from the
 * engine's own GameState blob instead - see projection.ts.
 *
 * `forSessionId`, when given, only ever adds the host-only `hostStage` field
 * (and only when that session actually is the host) - it never changes the
 * shared `stage` field itself, which stays role-redacted (S4) for everyone
 * regardless of who's asking. Pass it whenever the resulting state is going
 * to exactly one recipient (an ack, a resync) so a reconnecting host's
 * narration can resume immediately instead of waiting for the next natural
 * stage change; omit it for room-wide broadcasts. */
export async function getPublicState(
	code: string,
	forSessionId?: string
): Promise<RoomPublicState | null> {
	const room = await readRoomHash(code);
	if (!room) return null;

	const [players, seatsMap] = await Promise.all([getPlayers(code), getSeats(code)]);
	const gameState = IN_GAME_PHASES.includes(room.phase) ? await loadGameState(code) : null;

	const deadSeats = gameState ? deadSeatsOf(gameState) : [];
	const deadSet = new Set(deadSeats);
	const seats: SeatState[] = [];
	for (let i = 1; i <= room.numberOfSeats; i++) {
		const sessionId = seatsMap[String(i)] ?? null;
		seats.push({
			seatNumber: i,
			sessionId,
			username: sessionId ? (players[sessionId]?.username ?? null) : null,
			isDead: deadSet.has(i),
			...(gameState?.players[i]?.isRevealedIdiot ? { revealedIdiot: true } : {})
		});
	}

	// Deliberately not looked up from `players` (the seated-players hash): the
	// host is assigned the moment they submit the room config, before they've
	// necessarily taken a seat, so `players[hostSessionId]` may not exist yet.
	// The session record is the source of truth for a username regardless of
	// seating.
	const hostUsername = room.hostSessionId
		? ((await getSession(room.hostSessionId))?.username ?? null)
		: null;

	const state: RoomPublicState = {
		roomCode: code,
		phase: gameState ? mapToLegacyPhase(gameState) : room.phase,
		hostUsername,
		hostSessionId: room.hostSessionId || null,
		roleConfig: room.roleConfig,
		numberOfSeats: room.numberOfSeats,
		lockStatus: room.lockStatus,
		nightNumber: gameState ? gameState.round : room.nightNumber,
		stage: gameState ? toPublicStage(stageOf(gameState)) : null,
		seats,
		deadSeats,
		votedSeats: gameState ? votedSeatsOf(gameState) : [],
		totalVoters: gameState ? totalVotersOf(gameState) : 0,
		hunterSeat: gameState ? hunterSeatOf(gameState) : null,
		currentSpeaker: gameState ? currentSpeakerOf(gameState) : null,
		speechOrder: gameState ? speechOrderOf(gameState) : [],
		pkCandidates: gameState ? pkCandidatesOf(gameState) : [],
		winner: gameState ? winnerOf(gameState) : null,
		pendingNightAnnounce: gameState ? gameState.pendingNightDeaths !== null : false,
		dayDecided: gameState?.dayDecided ?? false,
		knightUsed: gameState?.knightUsed ?? false
	};

	if (room.phase === 'GAME_OVER' && gameState) {
		state.identities = identitiesOf(gameState);
	}

	if (gameState && forSessionId && forSessionId === room.hostSessionId) {
		state.hostStage = stageOf(gameState);
	}

	return state;
}

// -- Atomic operations (Lua-backed) ----------------------------------------

export async function takeSeatAtomic(
	code: string,
	sessionId: string,
	seat: number,
	username: string
): Promise<{ ok: true } | { ok: false; error: string }> {
	const raw = await redis.takeSeat(
		seatsKey(code),
		playersKey(code),
		identitiesKey(code),
		roomKey(code),
		sessionId,
		String(seat),
		username,
		ROOM_TTL_SECONDS
	);
	return JSON.parse(raw);
}

export async function leaveSeatAtomic(
	code: string,
	sessionId: string
): Promise<{ ok: true; vacated: boolean }> {
	const raw = await redis.leaveSeat(seatsKey(code), playersKey(code), sessionId);
	return JSON.parse(raw);
}

export async function submitRoomConfigAtomic(
	code: string,
	sessionId: string,
	roleConfig: Partial<Record<Role, number>>,
	numberOfSeats: number,
	deal: DealResult,
	cupidPoisonBlocksHunter: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
	const identitiesFlat: Record<string, Role> = { ...deal.identities };
	if (deal.buried) {
		identitiesFlat['buried1'] = deal.buried[0];
		identitiesFlat['buried2'] = deal.buried[1];
	}
	const raw = await redis.submitRoomConfig(
		roomKey(code),
		identitiesKey(code),
		seatsKey(code),
		deadSeatsKey(code),
		votesKey(code),
		coupleSeatsKey(code),
		revealedKey(code),
		sessionId,
		JSON.stringify(roleConfig),
		String(numberOfSeats),
		JSON.stringify(identitiesFlat),
		ROOM_TTL_SECONDS,
		cupidPoisonBlocksHunter ? '1' : '0'
	);
	return JSON.parse(raw);
}

export async function touchRoomTtl(code: string, night?: number): Promise<void> {
	const pipeline = redis.pipeline();
	for (const key of fixedRoomKeys(code)) pipeline.expire(key, ROOM_TTL_SECONDS);
	if (night !== undefined)
		pipeline.expire(`wolf:room:${code}:nightActions:${night}`, ROOM_TTL_SECONDS);
	await pipeline.exec();
}
