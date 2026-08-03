import { redis } from '../redis';
import { getSession } from '../session';
import {
	TAKE_SEAT_LUA,
	LEAVE_SEAT_LUA,
	SUBMIT_ROOM_CONFIG_LUA,
	ADVANCE_STAGE_LUA,
	HUNTER_SHOT_LUA
} from './lua/scripts';
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
import type { NightStage, Phase, RoomPublicState, SeatState } from '../../shared/gameTypes';
import type { DealResult } from '../../shared/deal';

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
		advanceStage(
			roomKey: string,
			expectedIndex: string,
			newIndex: string,
			ttl: number
		): Promise<string>;
		hunterShotGuard(roomKey: string, ttl: number): Promise<number>;
	}
}

redis.defineCommand('takeSeat', { numberOfKeys: 4, lua: TAKE_SEAT_LUA });
redis.defineCommand('leaveSeat', { numberOfKeys: 2, lua: LEAVE_SEAT_LUA });
redis.defineCommand('submitRoomConfig', { numberOfKeys: 7, lua: SUBMIT_ROOM_CONFIG_LUA });
redis.defineCommand('advanceStage', { numberOfKeys: 1, lua: ADVANCE_STAGE_LUA });
redis.defineCommand('hunterShotGuard', { numberOfKeys: 1, lua: HUNTER_SHOT_LUA });

export interface RoomHashData {
	phase: Phase;
	hostSessionId: string;
	roleConfig: Partial<Record<Role, number>>;
	numberOfSeats: number;
	lockStatus: boolean;
	nightNumber: number;
	stageIndex: number;
	stageOrder: NightStage[];
	hunterShotSeat: string | null;
	hunterShotResolved: boolean;
	phaseAfterHunterShot: 'DAY_VOTE' | 'NEXT_NIGHT' | null;
	winner: 'wolves' | 'villagers' | null;
	/** Last night's computed death list, held back from the public state and
	 * revealed only when the host broadcasts it (`NightAnnounceResults`) -
	 * null once there's nothing pending (including right after it's revealed). */
	pendingNightDeaths: number[] | null;
	/** Host-configurable house rule (default false): whether a hunter who dies
	 * via Cupid follow-death (殉情) because their linked partner was poisoned
	 * is also denied their shot, same as being poisoned directly. */
	cupidPoisonBlocksHunter: boolean;
	/** Whether the witch has spent each potion. Both are single-use for the
	 * WHOLE GAME, not per night, so they live on the room hash rather than in
	 * the per-night action hash. */
	witchUsedAntidote: boolean;
	witchUsedPoison: boolean;
	/** Who the guard protected last night, so tonight's turn can bar a repeat.
	 * Kept here rather than read back out of `nightActions:<n-1>`: callers
	 * already hold the room hash (no extra round-trip), and the previous
	 * night's key isn't re-armed by touchRoomTtl, so a long game could read a
	 * hole. */
	guardLastSeat: number | null;
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
		stageIndex: Number(data.stageIndex || 0),
		stageOrder: data.stageOrder ? JSON.parse(data.stageOrder) : [],
		hunterShotSeat: data.hunterShotSeat || null,
		hunterShotResolved: data.hunterShotResolved === '1',
		phaseAfterHunterShot:
			(data.phaseAfterHunterShot as 'DAY_VOTE' | 'NEXT_NIGHT' | undefined) || null,
		winner: (data.winner as 'wolves' | 'villagers') || null,
		pendingNightDeaths: data.pendingNightDeaths ? JSON.parse(data.pendingNightDeaths) : null,
		cupidPoisonBlocksHunter: data.cupidPoisonBlocksHunter === '1',
		// Rooms created before these fields existed parse as "unused"/"none",
		// which is the safe default (potions available, no guard restriction).
		witchUsedAntidote: data.witchUsedAntidote === '1',
		witchUsedPoison: data.witchUsedPoison === '1',
		guardLastSeat: data.guardLastSeat ? Number(data.guardLastSeat) : null
	};
}

export function currentStageOf(
	room: Pick<RoomHashData, 'stageOrder' | 'stageIndex'>
): NightStage | null {
	return room.stageOrder[room.stageIndex] ?? null;
}

export async function setStageOrder(code: string, stageOrder: NightStage[]): Promise<void> {
	await redis.hset(roomKey(code), {
		stageOrder: JSON.stringify(stageOrder),
		stageIndex: '0'
	});
	await redis.expire(roomKey(code), ROOM_TTL_SECONDS);
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

export async function getDeadSeats(code: string): Promise<number[]> {
	const members = await redis.smembers(deadSeatsKey(code));
	return members.map(Number).sort((a, b) => a - b);
}

export async function getVotes(code: string): Promise<Record<number, number | 'abstain'>> {
	const raw = await redis.hgetall(votesKey(code));
	const out: Record<number, number | 'abstain'> = {};
	for (const [seat, target] of Object.entries(raw)) {
		out[Number(seat)] = target === 'abstain' ? 'abstain' : Number(target);
	}
	return out;
}

export async function getCoupleSeats(code: string): Promise<[number, number] | null> {
	const members = await redis.smembers(coupleSeatsKey(code));
	if (members.length !== 2) return null;
	return [Number(members[0]), Number(members[1])].sort((a, b) => a - b) as [number, number];
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

/** Assembles the full public state, e.g. for StateSnapshot/ResyncRequest. */
export async function getPublicState(code: string): Promise<RoomPublicState | null> {
	const room = await readRoomHash(code);
	if (!room) return null;

	const [players, seatsMap, deadSeats, votes] = await Promise.all([
		getPlayers(code),
		getSeats(code),
		getDeadSeats(code),
		getVotes(code)
	]);

	const deadSet = new Set(deadSeats);
	const seats: SeatState[] = [];
	for (let i = 1; i <= room.numberOfSeats; i++) {
		const sessionId = seatsMap[String(i)] ?? null;
		seats.push({
			seatNumber: i,
			sessionId,
			username: sessionId ? (players[sessionId]?.username ?? null) : null,
			isDead: deadSet.has(i)
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
		phase: room.phase,
		hostUsername,
		hostSessionId: room.hostSessionId || null,
		roleConfig: room.roleConfig,
		numberOfSeats: room.numberOfSeats,
		lockStatus: room.lockStatus,
		nightNumber: room.nightNumber,
		stage: currentStageOf(room),
		seats,
		deadSeats,
		votes,
		hunterSeat: room.hunterShotSeat ? Number(room.hunterShotSeat) : null,
		winner: room.winner,
		pendingNightAnnounce: room.pendingNightDeaths !== null
	};

	if (room.phase === 'GAME_OVER') {
		state.identities = Object.fromEntries(
			Object.entries(await getIdentities(code))
				.filter(([seat]) => !seat.startsWith('buried'))
				.map(([seat, role]) => [Number(seat), role])
		);
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

export async function advanceStageAtomic(
	code: string,
	expectedIndex: number,
	newIndex: number
): Promise<{ ok: true } | { ok: false; error: string; current?: string }> {
	const raw = await redis.advanceStage(
		roomKey(code),
		String(expectedIndex),
		String(newIndex),
		ROOM_TTL_SECONDS
	);
	return JSON.parse(raw);
}

/** Returns true if this call won the exclusive right to resolve the pending shot. */
export async function claimHunterShot(code: string): Promise<boolean> {
	const result = await redis.hunterShotGuard(roomKey(code), ROOM_TTL_SECONDS);
	return result === 1;
}

export async function touchRoomTtl(code: string, night?: number): Promise<void> {
	const pipeline = redis.pipeline();
	for (const key of fixedRoomKeys(code)) pipeline.expire(key, ROOM_TTL_SECONDS);
	if (night !== undefined)
		pipeline.expire(`wolf:room:${code}:nightActions:${night}`, ROOM_TTL_SECONDS);
	await pipeline.exec();
}
