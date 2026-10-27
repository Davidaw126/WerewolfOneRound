import {
	createRoom,
	roomExists,
	submitRoomConfigAtomic,
	getPublicState,
	readRoomHash,
	getRevealedRoleIfAny,
	leaveSeatAtomic,
	seatOf,
	belongsToRoom,
	seatingForGameStart,
	setSeatsLocked,
	redeal,
	resetToSeating,
	destroyRoom
} from '../../rooms/roomRepo';
import { IN_PROGRESS_PHASES, PRE_GAME_PHASES } from '../../../shared/gameTypes';
import { setSessionRoom } from '../../session';
import { emitToRoom, emitToSession, roomChannel } from '../emit';
import { startAndSaveGame } from '../../game/gameStateRepo';
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
import { deriveSeatCount } from '../../../shared/deal';
import type { Role } from '../../../shared/roles';
import type { AckResponse } from '../../../shared/events';
import type { RoomPublicState } from '../../../shared/gameTypes';
import { requireRoomCode, requireHost, type GameSocket } from './helpers';

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
 * dealt/seated during LOBBY/SEATING - the bridge point where the wire's old
 * Role-keyed world hands off to the new RoleId-keyed engine. */
function buildStartGameParams(
	code: string,
	seating: NonNullable<Awaited<ReturnType<typeof seatingForGameStart>>>
): StartGameParams {
	const { room, identities, seated } = seating;

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
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
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
	await setSeatsLocked(code, locked);
	emitToRoom(code, { kind: 'LockUpdated', locked });
	return { ok: true };
}

export async function handleRoomRerollRoles(socket: GameSocket): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);

	const room = await readRoomHash(code);
	if (!room || room.phase !== 'SEATING') return { ok: false, error: 'invalid_phase' };

	await redeal(code);
	emitToRoom(code, { kind: 'RolesRerolled' });
	return { ok: true };
}

/** Back to SEATING with the same setup (see roomRepo.resetToSeating), then
 * tells the room. Shared by the Host's explicit RoomStopGame/GameOverScreen's
 * "再来一局" and a non-host's mid-game RoomLeave. */
async function softResetToSeating(code: string): Promise<void> {
	await resetToSeating(code);
	const state = await getPublicState(code);
	if (state) emitToRoom(code, { kind: 'StateSnapshot', state });
	emitToRoom(code, { kind: 'GameReset' });
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
