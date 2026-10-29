// The Room module: everything about the people at a table and the setup
// before a game - creating and closing the room, the Host, seats, the role
// setup and its deal (Re-deal included), who has seen their role - plus the
// one answer to "who sits in seat N / what role is seat N" at any time.
//
// Two stores sit behind this module and only this module knows which one is
// authoritative when:
//   - before a game (PRE_GAME_PHASES): the seating keys (room hash, seats,
//     players, identities, revealed), written atomically by the Lua scripts;
//   - once a game starts: the engine's GameState (gameStateRepo.ts) for who
//     sits where and what role they hold - the seating keys never learn
//     about in-game changes (上帝之手 改变身份, 盗贼, 野孩子). While a round is in
//     progress seats can't change, so the two agree on who sits where; at
//     GAME_OVER a player can still Leave, so seats come from the seating
//     keys again while roles keep coming from GameState.
// The Host is only ever recorded in the room hash.
//
// Handlers and the game IO shell call into here; none of them touch the
// room's Redis keys directly.

import { redis } from '../redis';
import { getSession } from '../session';
import { TAKE_SEAT_LUA, LEAVE_SEAT_LUA, SUBMIT_ROOM_CONFIG_LUA } from './lua/scripts';
import {
	ROOM_TTL_SECONDS,
	roomKey,
	seatsKey,
	playersKey,
	identitiesKey,
	revealedKey,
	fixedRoomKeys,
	randomRoomCode
} from './keys';
import {
	IN_PROGRESS_PHASES,
	PRE_GAME_PHASES,
	type Phase,
	type RoomPublicState,
	type SeatState
} from '../../shared/gameTypes';
import { dealCards, type DealResult } from '../../game/rules/deal';
import type { RuleConfigOverrides } from '../../game/ruleSwitches';
import type { GameState, RoleId } from '../../game/types';
import { ALL_ROLE_IDS } from '../../game/roleMeta';
import {
	loadGameState,
	deleteGameState,
	clearGameActions,
	withRoomLock,
	type Refusal
} from '../game/gameStateRepo';
import { legacyToRoleId } from '../../game/roleBridge';
import type { Role } from '../../shared/roles';
import {
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
			revealedKey: string,
			sessionId: string,
			roleConfigJson: string,
			numberOfSeats: string,
			identitiesJson: string,
			ttl: number,
			ruleOverridesJson: string
		): Promise<string>;
	}
}

redis.defineCommand('takeSeat', { numberOfKeys: 4, lua: TAKE_SEAT_LUA });
redis.defineCommand('leaveSeat', { numberOfKeys: 2, lua: LEAVE_SEAT_LUA });
redis.defineCommand('submitRoomConfig', { numberOfKeys: 4, lua: SUBMIT_ROOM_CONFIG_LUA });

// The room hash keeps the room-scope fields (seat/config/lobby lifecycle)
// plus `phase`/`nightNumber`, which recordGamePhase keeps in step with the
// GameState so phase-gated room logic (Leave, the join lock, the route
// guard) never has to load the game itself.
export interface RoomHashData {
	phase: Phase;
	hostSessionId: string;
	roleConfig: Partial<Record<RoleId, number>>;
	numberOfSeats: number;
	lockStatus: boolean;
	nightNumber: number;
	/** The Host's rule switches (game/ruleSwitches.ts), captured at
	 * RoomSubmitConfig time the same way roleConfig is, and merged onto
	 * defaultRuleConfig() at RoomStartGame time. */
	ruleOverrides: RuleConfigOverrides;
}

const isPreGame = (phase: Phase) => PRE_GAME_PHASES.includes(phase);

/** The room's phase is mirrored as the engine's own. A game running across
 * the deploy that changed that still has the older names stored until its
 * next action - read them as the nearest engine phase. */
const LEGACY_PHASE: Record<string, Phase> = {
	NIGHT_ACTIONS: 'NIGHT',
	NIGHT_HUNTER_SHOT: 'HUNTER_SHOOT',
	DAY_HUNTER_SHOT: 'HUNTER_SHOOT',
	DAY_VOTE: 'VOTE'
};

/** Roles are stored as RoleId. A room set up before that change (still in
 * Redis across a deploy) has Chinese role names instead - read those too. */
function asRoleId(value: string): RoleId | null {
	return (ALL_ROLE_IDS as readonly string[]).includes(value)
		? (value as RoleId)
		: legacyToRoleId(value as Role);
}

function toRoleIdKeys(config: Record<string, number>): Partial<Record<RoleId, number>> {
	const out: Partial<Record<RoleId, number>> = {};
	for (const [role, count] of Object.entries(config)) {
		const id = asRoleId(role);
		if (id) out[id] = (out[id] ?? 0) + count;
	}
	return out;
}

/** A room set up before the 丘比特 poison rule joined the other switches
 * stored it as its own field - fold that in. */
function readRuleOverrides(data: Record<string, string>): RuleConfigOverrides {
	const overrides: RuleConfigOverrides = data.ruleOverrides ? JSON.parse(data.ruleOverrides) : {};
	if (data.cupidPoisonBlocksHunter === '1' && overrides.cupidPoisonBlocksHunter === undefined)
		overrides.cupidPoisonBlocksHunter = true;
	return overrides;
}

export async function readRoomHash(code: string): Promise<RoomHashData | null> {
	const data = await redis.hgetall(roomKey(code));
	if (!data.phase) return null;
	return {
		phase: LEGACY_PHASE[data.phase] ?? ((data.phase || 'LOBBY') as Phase),
		hostSessionId: data.hostSessionId || '',
		roleConfig: data.roleConfig ? toRoleIdKeys(JSON.parse(data.roleConfig)) : {},
		numberOfSeats: Number(data.numberOfSeats || 0),
		lockStatus: data.lockStatus === '1',
		nightNumber: Number(data.nightNumber || 0),
		ruleOverrides: readRuleOverrides(data)
	};
}

export async function roomExists(code: string): Promise<boolean> {
	return (await redis.exists(roomKey(code))) === 1;
}

/** Opens a new room under a fresh code and returns the code. The Host is
 * whoever creates the room, not whoever happens to submit the config first -
 * a friend who joins via the room code before the creator finishes setting
 * up roles should see a waiting message, not the config form itself (and
 * definitely shouldn't be able to submit config out from under the actual
 * Host). */
export async function createRoom(hostSessionId: string): Promise<string> {
	let code = randomRoomCode();
	// Astronomically unlikely to collide, but check anyway - codes are only 6 digits.
	while (await roomExists(code)) code = randomRoomCode();
	await redis.hset(roomKey(code), {
		phase: 'LOBBY',
		roleConfig: '{}',
		numberOfSeats: '0',
		hostSessionId
	});
	await redis.expire(roomKey(code), ROOM_TTL_SECONDS);
	return code;
}

/** Deletes every key of the room. The Host leaving makes the room
 * permanently unmanageable (every host-gated action checks the one recorded
 * Host), so rather than leave an orphaned room nobody can ever advance
 * again, it goes outright. */
export async function destroyRoom(code: string): Promise<void> {
	const pipeline = redis.pipeline();
	for (const key of fixedRoomKeys(code)) pipeline.del(key);
	await pipeline.exec();
}

// -- The Host ----------------------------------------------------------------

export async function hostSessionOf(code: string): Promise<string | null> {
	return (await redis.hget(roomKey(code), 'hostSessionId')) || null;
}

export async function isHost(code: string, sessionId: string): Promise<boolean> {
	return (await hostSessionOf(code)) === sessionId;
}

/** Runs `fn` only if `sessionId` is the Host, with the check and `fn` both
 * under the room lock - so nothing (a later Hand over host, a Leave) can
 * change the Host in between. `fn` must not take the room lock itself. */
export async function asHost<T>(
	code: string,
	sessionId: string,
	fn: () => Promise<T>
): Promise<T | Refusal> {
	return withRoomLock(code, async () =>
		(await isHost(code, sessionId)) ? fn() : { ok: false as const, error: 'not_host' }
	);
}

export type LeaveOutcome =
	/** The Host left: the room is gone. */
	| { kind: 'closed' }
	/** A player left mid-round: back to SEATING for everyone. */
	| { kind: 'round_ended'; seat: number | null }
	/** A player left before (or after) a round. */
	| { kind: 'left'; vacated: boolean; redealt: boolean }
	/** The room no longer exists. */
	| { kind: 'none' };

/** Leave (离开), under the room lock. What it means depends on who leaves and
 * when: the Host leaving closes the room (nobody else could ever run it); a
 * player leaving mid-round ends the round; otherwise their seat is freed
 * (see freeSeat). Telling the room and unhooking phones is the caller's. */
export async function leaveRoom(code: string, sessionId: string): Promise<LeaveOutcome> {
	return withRoomLock(code, async () => {
		const room = await readRoomHash(code);
		if (!room) return { kind: 'none' };
		if (room.hostSessionId === sessionId) {
			await destroyRoom(code);
			return { kind: 'closed' };
		}
		if (IN_PROGRESS_PHASES.includes(room.phase)) {
			const seat = await seatOf(code, sessionId);
			await freeSeat(code, sessionId);
			await resetToSeating(code);
			return { kind: 'round_ended', seat };
		}
		return { kind: 'left', ...(await freeSeat(code, sessionId)) };
	});
}

// -- Seats -------------------------------------------------------------------

type SeatedPlayer = { seat: number; sessionId: string; username: string };

async function seatingKeysSeated(code: string): Promise<SeatedPlayer[]> {
	const [seats, players] = await Promise.all([
		redis.hgetall(seatsKey(code)),
		redis.hgetall(playersKey(code))
	]);
	const out: SeatedPlayer[] = [];
	for (const [seatStr, sessionId] of Object.entries(seats)) {
		if (!sessionId) continue;
		const player = players[sessionId] ? JSON.parse(players[sessionId]) : null;
		out.push({ seat: Number(seatStr), sessionId, username: player?.username ?? '' });
	}
	return out;
}

function gameStateSeated(state: GameState): SeatedPlayer[] {
	return Object.values(state.players).map((p) => ({
		seat: p.seat,
		sessionId: p.sessionId,
		username: p.nickname
	}));
}

/** Who sits where right now - see the module header for which store answers. */
async function seated(code: string, phase?: Phase): Promise<SeatedPlayer[]> {
	const roomPhase = phase ?? (await readRoomHash(code))?.phase;
	if (roomPhase && IN_PROGRESS_PHASES.includes(roomPhase)) {
		const state = await loadGameState(code);
		if (state) return gameStateSeated(state);
	}
	return seatingKeysSeated(code);
}

/** Which seat (if any) the given session currently occupies. */
export async function seatOf(code: string, sessionId: string): Promise<number | null> {
	return (await seated(code)).find((p) => p.sessionId === sessionId)?.seat ?? null;
}

/** Which session (if any) currently occupies the given seat. */
export async function sessionInSeat(code: string, seat: number): Promise<string | null> {
	return (await seated(code)).find((p) => p.seat === seat)?.sessionId ?? null;
}

/** The Host, or a player with a seat - someone who may come back into the
 * room even once it's locked against newcomers. */
export async function belongsToRoom(code: string, sessionId: string): Promise<boolean> {
	return (await isHost(code, sessionId)) || (await seatOf(code, sessionId)) !== null;
}

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

/** Frees whatever seat this session holds in the seating keys (`vacated` is
 * false if it held none). During seating, if that player had already looked
 * at their role, the whole table is re-dealt (`redealt`): the role stays with
 * the seat, so whoever sat there next would otherwise get a card the leaver
 * has seen. */
export async function freeSeat(
	code: string,
	sessionId: string
): Promise<{ vacated: boolean; redealt: boolean }> {
	const [room, hadLooked] = await Promise.all([
		readRoomHash(code),
		redis.sismember(revealedKey(code), sessionId)
	]);
	const raw = await redis.leaveSeat(seatsKey(code), playersKey(code), sessionId);
	const { vacated } = JSON.parse(raw) as { vacated: boolean };
	const redealt = vacated && hadLooked === 1 && room?.phase === 'SEATING';
	if (redealt) await redeal(code);
	return { vacated, redealt };
}

export async function setSeatsLocked(code: string, locked: boolean): Promise<void> {
	await redis.hset(roomKey(code), { lockStatus: locked ? '1' : '0' });
	await redis.expire(roomKey(code), ROOM_TTL_SECONDS);
}

// -- Roles -------------------------------------------------------------------

async function dealtIdentities(code: string): Promise<Record<string, RoleId>> {
	const out: Record<string, RoleId> = {};
	for (const [slot, role] of Object.entries(await redis.hgetall(identitiesKey(code)))) {
		const id = asRoleId(role);
		if (id) out[slot] = id;
	}
	return out;
}

function flattenDeal(deal: DealResult): Record<string, RoleId> {
	const flat: Record<string, RoleId> = { ...deal.identities };
	if (deal.buried) {
		flat['buried1'] = deal.buried[0];
		flat['buried2'] = deal.buried[1];
	}
	return flat;
}

/** Saves the Host's role setup and deals it, moving the room LOBBY ->
 * SEATING in one atomic write. Only the Host's own session may do this, and
 * only from LOBBY. */
export async function submitRoomConfigAtomic(
	code: string,
	sessionId: string,
	config: {
		roleConfig: Partial<Record<RoleId, number>>;
		numberOfSeats: number;
		ruleOverrides: RuleConfigOverrides;
	}
): Promise<{ ok: true } | { ok: false; error: string }> {
	const raw = await redis.submitRoomConfig(
		roomKey(code),
		identitiesKey(code),
		seatsKey(code),
		revealedKey(code),
		sessionId,
		JSON.stringify(config.roleConfig),
		String(config.numberOfSeats),
		JSON.stringify(flattenDeal(dealCards(config.roleConfig))),
		ROOM_TTL_SECONDS,
		JSON.stringify(config.ruleOverrides)
	);
	return JSON.parse(raw);
}

/** Re-deal: a fresh deal of the room's existing role setup, steering away
 * from the deal it replaces (see dealCards' `previous`) so the same seat
 * rarely gets the same special role twice running. Every earlier look at a
 * role is now stale, so all players must look again. */
export async function redeal(code: string): Promise<void> {
	const room = await readRoomHash(code);
	if (!room || Object.keys(room.roleConfig).length === 0) return;
	const previous = await dealtIdentities(code);
	const identities = flattenDeal(dealCards(room.roleConfig, undefined, previous));

	await redis
		.multi()
		.del(identitiesKey(code))
		.hset(identitiesKey(code), identities)
		.expire(identitiesKey(code), ROOM_TTL_SECONDS)
		.del(revealedKey(code))
		.exec();
}

/** The card a seat holds RIGHT NOW. Once a game has started that's the
 * engine's GameState, not the deal from seating - the deal never learns
 * about in-game changes (上帝之手's 改变身份, the 盗贼 taking a buried card),
 * so replaying it on a refresh/reconnect showed the player their old card. */
export async function currentRoleOfSeat(code: string, seat: number): Promise<RoleId | null> {
	const room = await readRoomHash(code);
	if (room && !isPreGame(room.phase)) {
		const gameState = await loadGameState(code);
		const player = gameState?.players[seat];
		if (player) return player.role;
	}
	return (await dealtIdentities(code))[String(seat)] ?? null;
}

export async function markRevealed(code: string, sessionId: string): Promise<void> {
	await redis.sadd(revealedKey(code), sessionId);
	await redis.expire(revealedKey(code), ROOM_TTL_SECONDS);
}

/** If this session has already looked at their current role, look it up
 * again (e.g. to replay it on reconnect) - otherwise null, so a client that
 * has never looked isn't shown one unprompted. */
export async function getRevealedRoleIfAny(
	code: string,
	sessionId: string
): Promise<RoleId | null> {
	if ((await redis.sismember(revealedKey(code), sessionId)) !== 1) return null;
	const seat = await seatOf(code, sessionId);
	if (seat === null) return null;
	return currentRoleOfSeat(code, seat);
}

// -- Game handoff ------------------------------------------------------------

/** Everything seating produced, for building the engine's StartGameParams. */
export async function seatingForGameStart(code: string): Promise<{
	room: RoomHashData;
	identities: Record<string, RoleId>;
	seated: SeatedPlayer[];
} | null> {
	const room = await readRoomHash(code);
	if (!room) return null;
	const [identities, players] = await Promise.all([dealtIdentities(code), seatingKeysSeated(code)]);
	return { room, identities, seated: players };
}

/** Mirrors the game's phase and round into the room hash, so room-scope
 * checks stay in step with GameState without loading it. */
export async function recordGamePhase(code: string, phase: Phase, round: number): Promise<void> {
	await redis.hset(roomKey(code), { phase, nightNumber: String(round) });
	await touchRoomTtl(code);
}

/** Ends the current round (or a finished one) and returns the room to
 * SEATING with the same setup: whoever is seated stays seated, the game
 * state and its action log go, and the roles are re-dealt - a new round
 * should never silently replay the old one's roles. */
export async function resetToSeating(code: string): Promise<void> {
	await redis.hset(roomKey(code), { phase: 'SEATING', lockStatus: '0', nightNumber: '0' });
	await redis.expire(roomKey(code), ROOM_TTL_SECONDS);
	await deleteGameState(code);
	await clearGameActions(code);
	await redeal(code);
}

export async function touchRoomTtl(code: string): Promise<void> {
	const pipeline = redis.pipeline();
	for (const key of fixedRoomKeys(code)) pipeline.expire(key, ROOM_TTL_SECONDS);
	await pipeline.exec();
}

// -- Public view ---------------------------------------------------------------

/** Assembles the full public state, e.g. for StateSnapshot/ResyncRequest.
 * Pre-game fields come from the seating keys; once a game has started, the
 * game-specific fields (stage, deaths, votes, hunter, winner, identities)
 * are projected fresh from the engine's own GameState instead - see
 * projection.ts.
 *
 * `forSessionId`, when given, only ever adds the host-only `hostStage` field
 * (and only when that session actually is the Host) - it never changes the
 * shared `stage` field itself, which stays role-redacted (S4) for everyone
 * regardless of who's asking. Pass it whenever the resulting state is going
 * to exactly one recipient (an ack, a resync) so a reconnecting Host's
 * narration can resume immediately instead of waiting for the next natural
 * stage change; omit it for room-wide broadcasts. */
export async function getPublicState(
	code: string,
	forSessionId?: string
): Promise<RoomPublicState | null> {
	const room = await readRoomHash(code);
	if (!room) return null;

	const gameState = isPreGame(room.phase) ? null : await loadGameState(code);
	const occupants = await seated(code, room.phase);

	const deadSeats = gameState ? deadSeatsOf(gameState) : [];
	const deadSet = new Set(deadSeats);
	const seats: SeatState[] = [];
	for (let i = 1; i <= room.numberOfSeats; i++) {
		const occupant = occupants.find((p) => p.seat === i);
		seats.push({
			seatNumber: i,
			sessionId: occupant?.sessionId ?? null,
			username: occupant ? occupant.username || null : null,
			isDead: deadSet.has(i),
			...(gameState?.players[i]?.isRevealedIdiot ? { revealedIdiot: true } : {})
		});
	}

	// Looked up from the session record, not the seated players: the Host
	// may not have taken a seat at all.
	const hostUsername = room.hostSessionId
		? ((await getSession(room.hostSessionId))?.username ?? null)
		: null;

	const state: RoomPublicState = {
		roomCode: code,
		phase: gameState ? gameState.phase : room.phase,
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
		dayDecided: gameState?.dayDecided ?? false,
		knightUsed: gameState?.knightUsed ?? false,
		...(gameState?.startedAt ? { gameId: String(gameState.startedAt) } : {})
	};

	if (room.phase === 'GAME_OVER' && gameState) {
		state.identities = identitiesOf(gameState);
	}

	if (gameState && forSessionId && forSessionId === room.hostSessionId) {
		state.hostStage = stageOf(gameState);
	}

	return state;
}
