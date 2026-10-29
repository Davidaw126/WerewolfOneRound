import type { ClientAction, AckResponse } from '../../shared/events';
import type { RoomPublicState } from '../../shared/gameTypes';
import type { ValidationIssue } from '../../game/rules/setup';
import { getPublicState, getRevealedRoleIfAny } from '../rooms/roomRepo';
import { emitToSession } from './emit';
import { replayTurnPromptIfAny } from '../game/turnReplay';
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
	handleNightNarrationStarted,
	handleNightPass,
	handleNightConfirmStage
} from './handlers/night';
import { handleVoteCast, handleVoteEnd } from './handlers/vote';
import { handleHunterShoot } from './handlers/hunter';
import {
	handleNextSpeaker,
	handleBeginVote,
	handleEndDay,
	handleExile,
	handleDayOut,
	handleSelfExplode,
	handleKnightDuel
} from './handlers/discussion';
import { handleHostOverride } from './handlers/hostOverride';

export async function dispatchAction(
	socket: GameSocket,
	action: ClientAction
): Promise<
	AckResponse & { roomCode?: string; state?: RoomPublicState; issues?: ValidationIssue[] }
> {
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
				return await handleRoomSubmitConfig(socket, action.roleConfig, action.ruleOverrides);
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
			case 'NightPass':
				return await handleNightPass(socket);
			case 'NightConfirmStage':
				return await handleNightConfirmStage(socket);
			case 'NightNarrationStarted':
				return await handleNightNarrationStarted(socket, action.role);
			case 'DayNextSpeaker':
				return await handleNextSpeaker(socket);
			case 'DayBeginVote':
				return await handleBeginVote(socket);
			case 'DayEndDay':
				return await handleEndDay(socket);
			case 'DayExile':
				return await handleExile(socket, action.seat);
			case 'DayOut':
				return await handleDayOut(socket, action.seats);
			case 'DaySelfExplode':
				return await handleSelfExplode(socket, action.seat);
			case 'DayKnightDuel':
				return await handleKnightDuel(socket, action.knightSeat, action.targetSeat);
			case 'VoteCast':
				return await handleVoteCast(socket, action.target);
			case 'VoteEnd':
				return await handleVoteEnd(socket);
			case 'HunterShoot':
				return await handleHunterShoot(socket, action.target);
			case 'HostOverride':
				return await handleHostOverride(socket, action.overrideKind, action.seat, action.role);
			case 'ResyncRequest': {
				const code = await requireRoomCode(socket);
				const state = await getPublicState(code, socket.data.sessionId);
				const revealedRole = await getRevealedRoleIfAny(code, socket.data.sessionId);
				if (revealedRole) {
					emitToSession(socket.data.sessionId, { kind: 'YourRole', role: revealedRole });
				}
				await replayTurnPromptIfAny(code, socket.data.sessionId);
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
