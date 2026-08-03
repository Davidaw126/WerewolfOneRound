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
	seatOf
} from '../../rooms/roomRepo';
import type { Phase } from '../../../shared/gameTypes';
import { setSessionRoom } from '../../session';
import { emitToRoom, emitToSession, roomChannel } from '../emit';
import { startNight1 } from '../../game/stateMachine';
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

	const state = await getPublicState(code);
	return { ok: true, roomCode: code, state: state ?? undefined };
}

export async function handleRoomJoin(
	socket: GameSocket,
	roomCode: string
): Promise<AckResponse & { state?: RoomPublicState }> {
	if (!(await roomExists(roomCode))) return { ok: false, error: 'room_not_found' };

	await setSessionRoom(socket.data.sessionId, roomCode);
	socket.data.roomCode = roomCode;
	socket.join(roomChannel(roomCode));

	const state = await getPublicState(roomCode);

	// If this session already tapped "reveal" before (e.g. a page refresh),
	// replay it privately rather than leaving them stuck on the tap-to-reveal
	// prompt for a role they've already seen.
	const revealedRole = await getRevealedRoleIfAny(roomCode, socket.data.sessionId);
	if (revealedRole) emitToSession(socket.data.sessionId, { kind: 'YourRole', role: revealedRole });

	return { ok: true, state: state ?? undefined };
}

export async function handleRoomSubmitConfig(
	socket: GameSocket,
	roleConfig: Partial<Record<Role, number>>,
	cupidPoisonBlocksHunter: boolean
): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	const numberOfSeats = deriveSeatCount(roleConfig);
	if (numberOfSeats <= 0) return { ok: false, error: 'empty_config' };

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

	// submitRoomConfigAtomic changes more than roleConfig - it also flips
	// phase LOBBY -> SEATING and resets seats/deadSeats/votes/coupleSeats in
	// the same atomic write. A full snapshot (rather than a narrower
	// RoomConfigUpdated-only event) means clients can't drift out of sync by
	// missing any one of those fields.
	const state = await getPublicState(code);
	if (state) emitToRoom(code, { kind: 'StateSnapshot', state });
	return { ok: true };
}

export async function handleRoomStartGame(socket: GameSocket): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	const room = await readRoomHash(code);
	if (!room || !room.lockStatus) return { ok: false, error: 'seats_not_locked' };
	await startNight1(code);
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

	const deal = dealCards(room.roleConfig);
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

	emitToRoom(code, { kind: 'RolesRerolled' });
	return { ok: true };
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
 * touching roleConfig/numberOfSeats/identities/seats - so whoever's already
 * seated stays seated, the vacated-or-not seats keep whatever role was
 * already dealt to them, and the host can just re-lock and start again with
 * the exact same setup instead of reconfiguring roles from scratch. Only
 * state specific to the aborted round (deaths/votes/couple-link/night
 * progress) is cleared - restarting night 1 with someone already marked dead
 * or an aborted vote in place would be inconsistent. Shared by the host's
 * explicit RoomStopGame/GameOverScreen's "再来一局" and a non-host's mid-game
 * RoomLeave. */
async function softResetToSeating(code: string): Promise<void> {
	// Read the night count BEFORE the hset below resets it to '0', otherwise
	// there's nothing left to tell us which per-night hashes to delete.
	const previous = await readRoomHash(code);

	await redis.hset(roomKey(code), {
		phase: 'SEATING',
		lockStatus: '0',
		nightNumber: '0',
		stageIndex: '0',
		stageOrder: '[]',
		winner: '',
		hunterShotSeat: '',
		hunterShotResolved: '0',
		pendingNightDeaths: '',
		witchUsedAntidote: '0',
		witchUsedPoison: '0',
		guardLastSeat: ''
	});
	await redis.expire(roomKey(code), ROOM_TTL_SECONDS);

	await redis.del(deadSeatsKey(code));
	await redis.del(votesKey(code));
	await redis.del(coupleSeatsKey(code));

	// Every night's action hash, not just the last one. Left behind, the next
	// game's night 1 would re-read the aborted game's kill/poison out of
	// `nightActions:1` and resolve phantom deaths (and show the witch a stale
	// "who was attacked", which her self-save rule keys off).
	if (previous && previous.nightNumber > 0) {
		const pipeline = redis.pipeline();
		for (let n = 1; n <= previous.nightNumber; n++) pipeline.del(nightActionsKey(code, n));
		await pipeline.exec();
	}

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
			emitToRoom(code, { kind: 'RoomClosed', message: '房主已离开，房间已关闭' });
		} else if (IN_PROGRESS_PHASES.includes(room.phase)) {
			const leavingSeat = await seatOf(code, socket.data.sessionId);
			await leaveSeatAtomic(code, socket.data.sessionId);
			await softResetToSeating(code);
			emitToRoom(code, {
				kind: 'ErrorToast',
				message:
					leavingSeat !== null
						? `${leavingSeat} 号玩家离开了房间，当前对局已结束`
						: '有玩家离开了房间，当前对局已结束'
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
