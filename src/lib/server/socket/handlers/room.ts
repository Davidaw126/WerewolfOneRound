import {
	createRoom,
	roomExists,
	submitRoomConfigAtomic,
	getPublicState,
	readRoomHash,
	getRevealedRoleIfAny,
	belongsToRoom,
	seatingForGameStart,
	setSeatsLocked,
	redeal,
	resetToSeating,
	asHost,
	leaveRoom
} from '../../rooms/roomRepo';
import { PRE_GAME_PHASES } from '../../../shared/gameTypes';
import { setSessionRoom } from '../../session';
import { emitToRoom, emitToSession, roomChannel, removeSessionFromRoom } from '../emit';
import { startGameAndBroadcast } from '../../game/gameSync';
import { replayTurnPromptIfAny } from '../../game/turnReplay';
import { buildSetup, validateSetup, type ValidationIssue } from '../../../game/rules/setup';
import {
	defaultRuleConfig,
	mergeRuleConfig,
	type RuleConfigOverrides
} from '../../../game/defaultRuleConfig';
import type { RoleId } from '../../../game/types';
import type { DealResult as EngineDealResult } from '../../../game/rules/deal';
import type { StartGameParams } from '../../../game/engine';
import { deriveSeatCount } from '../../../game/rules/deal';
import type { AckResponse } from '../../../shared/events';
import type { RoomPublicState } from '../../../shared/gameTypes';
import { requireRoomCode, type GameSocket } from './helpers';

export async function handleRoomCreate(
	socket: GameSocket
): Promise<AckResponse & { roomCode?: string; state?: RoomPublicState }> {
	const code = await createRoom(socket.data.sessionId);
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
	const alreadyInRoom = room !== null && (await belongsToRoom(roomCode, sessionId));

	// S10 房间锁定: once the host locks seats (or the game has actually
	// started), a session with no existing relationship to this room can't
	// newly join - an anonymous room-code guesser shouldn't be able to sit in
	// on (or eavesdrop the public broadcasts of) an in-progress game. A
	// returning player - already seated, or the host - must always get back
	// in regardless: RoomJoin is also this app's own full-page-reload
	// recovery path, not just first-time joining (a socket-level reconnect
	// after a network drop is separate again, via ResyncRequest, and never
	// reaches this check at all).
	if (!alreadyInRoom && room && (room.lockStatus || !PRE_GAME_PHASES.includes(room.phase))) {
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
	submitted: Partial<Record<RoleId, number>>,
	cupidPoisonBlocksHunter: boolean,
	ruleOverrides?: RuleConfigOverrides
): Promise<AckResponse & { issues?: ValidationIssue[] }> {
	const code = await requireRoomCode(socket);
	// Only the Host may submit - checked atomically by submitRoomConfigAtomic.
	// Only roles actually in play are kept (the picker sends zeros too).
	const roleConfig: Partial<Record<RoleId, number>> = {};
	for (const [role, count] of Object.entries(submitted) as [RoleId, number][]) {
		if (count > 0) roleConfig[role] = count;
	}
	const numberOfSeats = deriveSeatCount(roleConfig);
	if (numberOfSeats <= 0) return { ok: false, error: 'empty_config' };

	// §5.2 E02-E09 - the composition checks that make sense before anyone's
	// even seated. E01 (role total vs. actual player count) is deferred to
	// RoomStartGame, when there's a real seated headcount to check against;
	// against numberOfSeats itself it would just trivially always pass here.
	const validation = validateSetup(buildSetup(roleConfig), numberOfSeats);
	if (!validation.ok) {
		return { ok: false, error: validation.errors[0].code, issues: validation.errors };
	}

	const result = await submitRoomConfigAtomic(code, socket.data.sessionId, {
		roleConfig,
		numberOfSeats,
		cupidPoisonBlocksHunter,
		ruleOverrides: ruleOverrides ?? {}
	});
	if (!result.ok) return result;

	// submitRoomConfigAtomic changes more than roleConfig - it also deals,
	// flips phase LOBBY -> SEATING and resets seats in the same atomic write. A full snapshot (rather than a narrower
	// RoomConfigUpdated-only event) means clients can't drift out of sync by
	// missing any one of those fields.
	const state = await getPublicState(code);
	if (state) emitToRoom(code, { kind: 'StateSnapshot', state });
	return { ok: true, issues: validation.warnings.length > 0 ? validation.warnings : undefined };
}

/** Builds the engine's StartGameParams from everything the room already
 * dealt/seated during LOBBY/SEATING. */
function buildStartGameParams(
	code: string,
	seating: NonNullable<Awaited<ReturnType<typeof seatingForGameStart>>>
): StartGameParams {
	const { room, identities, seated } = seating;

	const roleIdIdentities: Record<string, RoleId> = {};
	let buried: [RoleId, RoleId] | null = null;
	const buriedRoles: RoleId[] = [];
	for (const [seatKey, roleId] of Object.entries(identities)) {
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

	const players: StartGameParams['players'] = seated.map((p) => ({
		seat: p.seat,
		sessionId: p.sessionId,
		nickname: p.username || `Seat ${p.seat}`
	}));

	const deal: EngineDealResult = { identities: roleIdIdentities, buried };
	return {
		roomCode: code,
		ruleConfig: mergeRuleConfig(
			{
				...defaultRuleConfig(),
				cupidPoisonBlocksHunter: room.cupidPoisonBlocksHunter
			},
			room.ruleOverrides
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
	const code = await requireRoomCode(socket);
	const seating = await seatingForGameStart(code);
	if (!seating || !seating.room.lockStatus) return { ok: false, error: 'seats_not_locked' };

	const params = buildStartGameParams(code, seating);

	// Re-validates the full setup against who's ACTUALLY seated now (E01's
	// real job - catches a room locked with empty seats, which nothing else
	// in this app, old or new, has ever checked for) plus every other §5.2
	// rule again for defense in depth.
	const validation = validateSetup(params.setup, params.players.length);
	if (!validation.ok) {
		return { ok: false, error: validation.errors[0].code, issues: validation.errors };
	}

	// The Host and the seat lock are checked again under the room lock.
	return startGameAndBroadcast(code, params, socket.data.sessionId);
}

export async function handleRoomLockSeats(
	socket: GameSocket,
	locked: boolean
): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	// Host-only in both directions - locking gates the start-game handoff above,
	// and an unlock from anyone else would reopen SeatTake mid-handoff too.
	const done = await asHost(code, socket.data.sessionId, () => setSeatsLocked(code, locked));
	if (done) return done;
	emitToRoom(code, { kind: 'LockUpdated', locked });
	return { ok: true };
}

export async function handleRoomRerollRoles(socket: GameSocket): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	const done = await asHost(code, socket.data.sessionId, async () => {
		const room = await readRoomHash(code);
		if (!room || room.phase !== 'SEATING') return { ok: false as const, error: 'invalid_phase' };
		await redeal(code);
		return null;
	});
	if (done) return done;
	emitToRoom(code, { kind: 'RolesRerolled' });
	return { ok: true };
}

/** Tells the room it's back to SEATING (see roomRepo.resetToSeating).
 * Shared by the Host's RoomStopGame/"再来一局" and a player's mid-round Leave. */
async function announceBackToSeating(code: string): Promise<void> {
	const state = await getPublicState(code);
	if (state) emitToRoom(code, { kind: 'StateSnapshot', state });
	emitToRoom(code, { kind: 'GameReset' });
}

export async function handleRoomStopGame(socket: GameSocket): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	const done = await asHost(code, socket.data.sessionId, async () => {
		const room = await readRoomHash(code);
		if (!room || room.phase === 'LOBBY') return { ok: false as const, error: 'invalid_phase' };
		await resetToSeating(code);
		return null;
	});
	if (done) return done;
	await announceBackToSeating(code);
	return { ok: true };
}

export async function handleRoomLeave(socket: GameSocket): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	const sessionId = socket.data.sessionId;
	const outcome = await leaveRoom(code, sessionId);

	switch (outcome.kind) {
		case 'closed':
			emitToRoom(code, { kind: 'RoomClosed', reason: 'host_left' });
			break;
		case 'round_ended':
			await announceBackToSeating(code);
			emitToRoom(code, { kind: 'ErrorToast', reason: 'player_left_mid_game', seat: outcome.seat });
			break;
		case 'left': {
			if (outcome.vacated) {
				const state = await getPublicState(code);
				if (state) emitToRoom(code, { kind: 'SeatUpdated', seats: state.seats });
			}
			if (outcome.redealt) emitToRoom(code, { kind: 'RolesRerolled', reason: 'seen_role_left' });
			break;
		}
	}

	await setSessionRoom(sessionId, null);
	removeSessionFromRoom(sessionId, code);
	socket.data.roomCode = null;
	return { ok: true };
}
