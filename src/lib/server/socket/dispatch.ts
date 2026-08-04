import type { ClientAction, AckResponse } from '../../shared/events';
import type { RoomPublicState } from '../../shared/gameTypes';
import { getPublicState, getRevealedRoleIfAny } from '../rooms/roomRepo';
import { emitToSession } from './emit';
import { checkRateLimit } from './rateLimit';
import { ActionError, requireRoomCode, type GameSocket } from './handlers/helpers';
import {
	handleRoomCreate,
	handleRoomJoin,
	handleRoomSubmitConfig,
	handleRoomStartGame,
	handleRoomLockSeats,
	handleRoomRerollRoles,
	handleRoomLeave,
	handleRoomStopGame
} from './handlers/room';
import { handleSeatTake, handleRevealRole } from './handlers/seat';
import {
	handleNightSubmitAction,
	handleNightAdvanceStage,
	handleNightAnnounceResults,
	handleNightNarrationStarted
} from './handlers/night';
import { handleVoteCast, handleVoteEnd } from './handlers/vote';
import { handleHunterShoot } from './handlers/hunter';

export async function dispatchAction(
	socket: GameSocket,
	action: ClientAction
): Promise<AckResponse & { roomCode?: string; state?: RoomPublicState }> {
	if (!(await checkRateLimit(socket.data.sessionId))) {
		return { ok: false, error: 'rate_limited' };
	}
	try {
		switch (action.kind) {
			case 'RoomCreate':
				return await handleRoomCreate(socket);
			case 'RoomJoin':
				return await handleRoomJoin(socket, action.roomCode);
			case 'RoomSubmitConfig':
				return await handleRoomSubmitConfig(
					socket,
					action.roleConfig,
					action.cupidPoisonBlocksHunter
				);
			case 'RoomStartGame':
				return await handleRoomStartGame(socket);
			case 'RoomLockSeats':
				return await handleRoomLockSeats(socket, action.locked);
			case 'SeatTake':
				return await handleSeatTake(socket, action.seatNumber);
			case 'RevealRole':
				return await handleRevealRole(socket);
			case 'RoomRerollRoles':
				return await handleRoomRerollRoles(socket);
			case 'RoomLeave':
				return await handleRoomLeave(socket);
			case 'RoomStopGame':
				return await handleRoomStopGame(socket);
			case 'NightSubmitAction':
				return await handleNightSubmitAction(socket, action.action);
			case 'NightAdvanceStage':
				return await handleNightAdvanceStage(socket);
			case 'NightAnnounceResults':
				return await handleNightAnnounceResults(socket);
			case 'NightNarrationStarted':
				return await handleNightNarrationStarted(socket, action.role);
			case 'VoteCast':
				return await handleVoteCast(socket, action.target);
			case 'VoteEnd':
				return await handleVoteEnd(socket);
			case 'HunterShoot':
				return await handleHunterShoot(socket, action.target);
			case 'ResyncRequest': {
				const code = requireRoomCode(socket);
				const state = await getPublicState(code);
				const revealedRole = await getRevealedRoleIfAny(code, socket.data.sessionId);
				if (revealedRole) {
					emitToSession(socket.data.sessionId, { kind: 'YourRole', role: revealedRole });
				}
				return { ok: true, state: state ?? undefined };
			}
		}
	} catch (err) {
		if (err instanceof ActionError) {
			return { ok: false, error: err.message };
		}
		throw err;
	}
}
