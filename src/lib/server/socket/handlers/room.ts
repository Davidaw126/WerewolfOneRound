import { redis } from '../../redis';
import {
	randomRoomCode,
	roomKey,
	identitiesKey,
	deadSeatsKey,
	votesKey,
	coupleSeatsKey,
	revealedKey,
	fixedRoomKeys,
	nightActionsKey,
	ROOM_TTL_SECONDS
} from '../../rooms/keys';
import {
	createRoom,
	roomExists,
	submitRoomConfigAtomic,
	getPublicState,
	readRoomHash,
	getRevealedRoleIfAny,
	leaveSeatAtomic,
	seatOf,
	getIdentities,
	getPlayers,
	getSeats
} from '../../rooms/roomRepo';
import type { Phase } from '../../../shared/gameTypes';
import { setSessionRoom } from '../../session';
import { emitToRoom, emitToSession, roomChannel } from '../emit';
import { startAndSaveGame, deleteGameState, clearGameActions } from '../../game/gameStateRepo';
import { syncAndBroadcastGameStart } from '../../game/gameSync';
import { replayTurnPromptIfAny } from '../../game/turnReplay';
import { legacyToRoleId } from '../../../game/roleBridge';
import { buildSetup, validateSetup, type ValidationIssue } from '../../../game/rules/setup';
import {
	defaultRuleConfig,
	mergeRuleConfig,
	type RuleConfigOverrides
} from '../../../game/defaultRuleConfig';
import type { RoleId } from '../../../game/types';
import type { DealResult as EngineDealResult } from '../../../game/rules/deal';
import type { StartGameParams } from '../../../game/engine';
import { deriveSeatCount, dealCards } from '../../../shared/deal';
import type { Role } from '../../../shared/roles';
import type { AckResponse } from '../../../shared/events';
import type { RoomPublicState } from '../../../shared/gameTypes';
import { requireRoomCode, requireHost, type GameSocket } from './helpers';

export async function handleRoomCreate(
	socket: GameSocket
): Promise<AckResponse & { roomCode?: string; state?: RoomPublicState }> {
	let code = randomRoomCode();
	// Astronomically unlikely to collide, but check anyway - codes are only 6 digits.
	while (await roomExists(code)) {
		code = randomRoomCode();
	}
	await createRoom(code, socket.data.sessionId);
	await setSessionRoom(socket.data.sessionId, code);
	socket.data.roomCode = code;
	socket.join(roomChannel(code));

	const state = await getPublicState(code, socket.data.sessionId);
	return { ok: true, roomCode: code, state: state ?? undefined };
}

export async function handleRoomJoin(
	socket: GameSocket,
	roomCode: string
): Promise<AckResponse & { state?: RoomPublicState }> {
	if (!(await roomExists(roomCode))) return { ok: false, error: 'room_not_found' };

	const room = await readRoomHash(roomCode);
	const sessionId = socket.data.sessionId;
	const alreadyInRoom =
		room !== null &&
		(room.hostSessionId === sessionId || (await seatOf(roomCode, sessionId)) !== null);

	// S10 房间锁定: once the host locks seats (or the game has actually
	// started), a session with no existing relationship to this room can't
	// newly join - an anonymous room-code guesser shouldn't be able to sit in
	// on (or eavesdrop the public broadcasts of) an in-progress game. A
	// returning player - already seated, or the host - must always get back
	// in regardless: RoomJoin is also this app's own full-page-reload
	// recovery path, not just first-time joining (a socket-level reconnect
	// after a network drop is separate again, via ResyncRequest, and never
	// reaches this check at all).
	if (
		!alreadyInRoom &&
		room &&
		(room.lockStatus || (room.phase !== 'LOBBY' && room.phase !== 'SEATING'))
	) {
		return { ok: false, error: 'room_locked' };
	}

	await setSessionRoom(sessionId, roomCode);
	socket.data.roomCode = roomCode;
	socket.join(roomChannel(roomCode));

	const state = await getPublicState(roomCode, socket.data.sessionId);

	// If this session already tapped "reveal" before (e.g. a page refresh),
	// replay it privately rather than leaving them stuck on the tap-to-reveal
	// prompt for a role they've already seen.
	const revealedRole = await getRevealedRoleIfAny(roomCode, socket.data.sessionId);
	if (revealedRole) emitToSession(socket.data.sessionId, { kind: 'YourRole', role: revealedRole });
	await replayTurnPromptIfAny(roomCode, socket.data.sessionId);

	return { ok: true, state: state ?? undefined };
}

export async function handleRoomSubmitConfig(
	socket: GameSocket,
	roleConfig: Partial<Record<Role, number>>,
	cupidPoisonBlocksHunter: boolean,
	ruleOverrides?: RuleConfigOverrides
): Promise<AckResponse & { issues?: ValidationIssue[] }> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	const numberOfSeats = deriveSeatCount(roleConfig);
	if (numberOfSeats <= 0) return { ok: false, error: 'empty_config' };

	// The new engine only knows the spec's 15-role roster (M0 plan decision 3)
	// - RoleConfigPanel.svelte already narrows the picker to just those, so
	// this only ever fires for a stale client/cached page. Caught here,
	// before anyone's seated or a single card is dealt, rather than leaving a
	// host to discover it only once they try to start the game.
	const roleIdConfig: Partial<Record<RoleId, number>> = {};
	for (const [role, count] of Object.entries(roleConfig)) {
		if ((count ?? 0) === 0) continue;
		const roleId = legacyToRoleId(role as Role);
		if (!roleId) return { ok: false, error: 'unsupported_role_in_config' };
		roleIdConfig[roleId] = (roleIdConfig[roleId] ?? 0) + (count ?? 0);
	}

	// §5.2 E02-E09 - the composition checks that make sense before anyone's
	// even seated. E01 (role total vs. actual player count) is deferred to
	// RoomStartGame, when there's a real seated headcount to check against;
	// against numberOfSeats itself it would just trivially always pass here.
	const validation = validateSetup(buildSetup(roleIdConfig), numberOfSeats);
	if (!validation.ok) {
		return { ok: false, error: validation.errors[0].code, issues: validation.errors };
	}

	const deal = dealCards(roleConfig);
	const result = await submitRoomConfigAtomic(
		code,
		socket.data.sessionId,
		roleConfig,
		numberOfSeats,
		deal,
		cupidPoisonBlocksHunter
	);
	if (!result.ok) return result;

	await redis.hset(roomKey(code), { ruleOverrides: JSON.stringify(ruleOverrides ?? {}) });

	// submitRoomConfigAtomic changes more than roleConfig - it also flips
	// phase LOBBY -> SEATING and resets seats/deadSeats/votes/coupleSeats in
	// the same atomic write. A full snapshot (rather than a narrower
	// RoomConfigUpdated-only event) means clients can't drift out of sync by
	// missing any one of those fields.
	const state = await getPublicState(code);
	if (state) emitToRoom(code, { kind: 'StateSnapshot', state });
	return { ok: true, issues: validation.warnings.length > 0 ? validation.warnings : undefined };
}

/** Builds the engine's StartGameParams from everything RoomManager-scope
 * already dealt/seated during LOBBY/SEATING (unaffected by M1 - see the
 * module header) - the bridge point where the wire's old Role-keyed world
 * hands off to the new RoleId-keyed engine. */
async function buildStartGameParams(
	code: string,
	room: { hostSessionId: string }
): Promise<StartGameParams> {
	const [identities, playersMap, seatsMap] = await Promise.all([
		getIdentities(code),
		getPlayers(code),
		getSeats(code)
	]);

	const roleIdIdentities: Record<string, RoleId> = {};
	let buried: [RoleId, RoleId] | null = null;
	const buriedRoles: RoleId[] = [];
	for (const [seatKey, role] of Object.entries(identities)) {
		const roleId = legacyToRoleId(role);
		if (!roleId) continue; // already rejected at RoomSubmitConfig time - defensive only
		if (seatKey === 'buried1' || seatKey === 'buried2') {
			buriedRoles.push(roleId);
			continue;
		}
		roleIdIdentities[seatKey] = roleId;
	}
	if (buriedRoles.length === 2) buried = [buriedRoles[0], buriedRoles[1]];

	const roleIdConfig: Partial<Record<RoleId, number>> = {};
	for (const role of Object.values(roleIdIdentities)) {
		roleIdConfig[role] = (roleIdConfig[role] ?? 0) + 1;
	}
	if (buried) for (const role of buried) roleIdConfig[role] = (roleIdConfig[role] ?? 0) + 1;

	const players: StartGameParams['players'] = [];
	for (const [seatStr, sessionId] of Object.entries(seatsMap)) {
		if (!sessionId) continue;
		players.push({
			seat: Number(seatStr),
			sessionId,
			nickname: playersMap[sessionId]?.username ?? `Seat ${seatStr}`,
			isHost: sessionId === room.hostSessionId
		});
	}

	const deal: EngineDealResult = { identities: roleIdIdentities, buried };
	const roomHash = await readRoomHash(code);
	return {
		roomCode: code,
		ruleConfig: mergeRuleConfig(
			{
				...defaultRuleConfig(),
				cupidPoisonBlocksHunter: roomHash?.cupidPoisonBlocksHunter ?? false
			},
			roomHash?.ruleOverrides
		),
		setup: buildSetup(roleIdConfig),
		deal,
		players,
		now: Date.now()
	};
}

export async function handleRoomStartGame(
	socket: GameSocket
): Promise<AckResponse & { issues?: ValidationIssue[] }> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	const room = await readRoomHash(code);
	if (!room || !room.lockStatus) return { ok: false, error: 'seats_not_locked' };

	const params = await buildStartGameParams(code, room);

	// Re-validates the full setup against who's ACTUALLY seated now (E01's
	// real job - catches a room locked with empty seats, which nothing else
	// in this app, old or new, has ever checked for) plus every other §5.2
	// rule again for defense in depth.
	const validation = validateSetup(params.setup, params.players.length);
	if (!validation.ok) {
		return { ok: false, error: validation.errors[0].code, issues: validation.errors };
	}

	const result = await startAndSaveGame(code, params);
	await syncAndBroadcastGameStart(code, result);
	return { ok: true };
}

export async function handleRoomLockSeats(
	socket: GameSocket,
	locked: boolean
): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	// Host-only in both directions - locking gates the start-game handoff above,
	// and an unlock from anyone else would reopen SeatTake mid-handoff too.
	await requireHost(code, socket.data.sessionId);
	await redis.hset(roomKey(code), { lockStatus: locked ? '1' : '0' });
	await redis.expire(roomKey(code), ROOM_TTL_SECONDS);
	emitToRoom(code, { kind: 'LockUpdated', locked });
	return { ok: true };
}

export async function handleRoomRerollRoles(socket: GameSocket): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);

	const room = await readRoomHash(code);
	if (!room || room.phase !== 'SEATING') return { ok: false, error: 'invalid_phase' };

	await redealIdentities(code, room.roleConfig);
	emitToRoom(code, { kind: 'RolesRerolled' });
	return { ok: true };
}

/** Deals a fresh set of identities for the room's existing roleConfig,
 * steering away from the deal it replaces (see dealCards' `previous`) so the
 * same seat rarely gets the same special role twice running. Used by the
 * host's explicit reshuffle and by every return to SEATING (再来一局), which
 * used to keep the old deal - silently giving everyone the exact role they
 * just played unless the host remembered to tap reshuffle. */
async function redealIdentities(
	code: string,
	roleConfig: Partial<Record<Role, number>>
): Promise<void> {
	const previous = await getIdentities(code);
	const deal = dealCards(roleConfig, undefined, previous);
	const identitiesFlat: Record<string, Role> = { ...deal.identities };
	if (deal.buried) {
		identitiesFlat['buried1'] = deal.buried[0];
		identitiesFlat['buried2'] = deal.buried[1];
	}

	await redis.del(identitiesKey(code));
	await redis.hset(identitiesKey(code), identitiesFlat);
	await redis.expire(identitiesKey(code), ROOM_TTL_SECONDS);
	// Every previous reveal is now stale - clear it so players must re-tap to
	// see the role they were actually just reshuffled into.
	await redis.del(revealedKey(code));
}

// Phases with an active turn/vote in flight - one player leaving mid-way
// leaves a seat/identity nobody can act for anymore (the night can never
// auto-advance past a seat that's gone), so the round in progress can't
// safely continue. LOBBY/SEATING have no such in-flight state to break, and
// GAME_OVER has already concluded - leaving during either is just a quiet
// seat-vacate, not a forced round-reset for everyone still looking at the
// results screen.
const IN_PROGRESS_PHASES: Phase[] = [
	'NIGHT_ACTIONS',
	'NIGHT_HUNTER_SHOT',
	'DAY_VOTE',
	'DAY_HUNTER_SHOT'
];

/** Resets an in-progress (or just-finished) round back to SEATING without
 * touching roleConfig/numberOfSeats/seats - so whoever's already seated stays
 * seated and the host can just re-lock and start again with the exact same
 * setup instead of reconfiguring roles from scratch. Identities ARE re-dealt
 * (redealIdentities): a new round should never silently replay the old one's
 * roles. Only
 * state specific to the aborted round (the engine's own GameState/action log,
 * plus the legacy deaths/votes/couple-link keys nothing writes anymore but
 * are still cleared for tidiness) is cleared. Shared by the host's explicit
 * RoomStopGame/GameOverScreen's "再来一局" and a non-host's mid-game
 * RoomLeave. */
async function softResetToSeating(code: string): Promise<void> {
	const room = await readRoomHash(code);
	await redis.hset(roomKey(code), {
		phase: 'SEATING',
		lockStatus: '0',
		nightNumber: '0'
	});
	await redis.expire(roomKey(code), ROOM_TTL_SECONDS);

	await redis.del(deadSeatsKey(code));
	await redis.del(votesKey(code));
	await redis.del(coupleSeatsKey(code));
	await deleteGameState(code);
	await clearGameActions(code);
	// A new round gets a new deal (same roleConfig) - see redealIdentities.
	if (room && Object.keys(room.roleConfig).length > 0)
		await redealIdentities(code, room.roleConfig);

	const state = await getPublicState(code);
	if (state) emitToRoom(code, { kind: 'StateSnapshot', state });
	emitToRoom(code, { kind: 'GameReset' });
}

/** The host leaving makes the room permanently unmanageable - every
 * host-gated action (submit config, lock seats, start/stop game, reroll)
 * checks requireHost against the ONE sessionId recorded at config-submit
 * time, with no way for anyone else to take over. Rather than leave an
 * orphaned room nobody can ever advance again, delete it outright. */
async function destroyRoom(code: string): Promise<void> {
	const room = await readRoomHash(code);
	const pipeline = redis.pipeline();
	for (const key of fixedRoomKeys(code)) pipeline.del(key);
	// Every night played, not just the current one - the earlier hashes would
	// otherwise linger until their own TTL expired.
	if (room) for (let n = 1; n <= room.nightNumber; n++) pipeline.del(nightActionsKey(code, n));
	await pipeline.exec();
}

export async function handleRoomStopGame(socket: GameSocket): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);

	const room = await readRoomHash(code);
	if (!room || room.phase === 'LOBBY') return { ok: false, error: 'invalid_phase' };

	await softResetToSeating(code);
	return { ok: true };
}

export async function handleRoomLeave(socket: GameSocket): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	const room = await readRoomHash(code);

	if (room) {
		const isHost = room.hostSessionId !== '' && room.hostSessionId === socket.data.sessionId;

		if (isHost) {
			await destroyRoom(code);
			emitToRoom(code, { kind: 'RoomClosed', reason: 'host_left' });
		} else if (IN_PROGRESS_PHASES.includes(room.phase)) {
			const leavingSeat = await seatOf(code, socket.data.sessionId);
			await leaveSeatAtomic(code, socket.data.sessionId);
			await softResetToSeating(code);
			emitToRoom(code, {
				kind: 'ErrorToast',
				reason: 'player_left_mid_game',
				seat: leavingSeat
			});
		} else {
			const { vacated } = await leaveSeatAtomic(code, socket.data.sessionId);
			if (vacated) {
				const state = await getPublicState(code);
				if (state) emitToRoom(code, { kind: 'SeatUpdated', seats: state.seats });
			}
		}
	}

	await setSessionRoom(socket.data.sessionId, null);
	socket.leave(roomChannel(code));
	socket.data.roomCode = null;
	return { ok: true };
}
