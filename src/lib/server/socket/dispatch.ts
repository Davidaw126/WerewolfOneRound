import {
	refuse,
	type ClientAction,
	type ActionKind,
	type ActionOf,
	type ActionReply
} from '../../shared/events';
import { checkRateLimit } from './rateLimit';
import { ActionError, type GameSocket } from './handlers/helpers';
import {
	handleRoomCreate,
	handleRoomJoin,
	handleResync,
	handleRoomSubmitConfig,
	handleRoomStartGame,
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

type Handler<K extends ActionKind> = (
	socket: GameSocket,
	action: ActionOf<K>
) => Promise<ActionReply<K>>;

/** One handler per action, each typed to answer that action's own reply -
 * a handler that answers the wrong shape fails to compile. */
const HANDLERS: { [K in ActionKind]: Handler<K> } = {
	RoomCreate: (s) => handleRoomCreate(s),
	RoomJoin: (s, a) => handleRoomJoin(s, a.roomCode),
	ResyncRequest: (s) => handleResync(s),
	RoomSubmitConfig: (s, a) => handleRoomSubmitConfig(s, a.roleConfig, a.ruleOverrides),
	RoomStartGame: (s) => handleRoomStartGame(s),
	SeatTake: (s, a) => handleSeatTake(s, a.seatNumber),
	RevealRole: (s) => handleRevealRole(s),
	RoomRerollRoles: (s) => handleRoomRerollRoles(s),
	RoomLeave: (s) => handleRoomLeave(s),
	RoomStopGame: (s) => handleRoomStopGame(s),
	NightSubmitAction: (s, a) => handleNightSubmitAction(s, a.action),
	NightAdvanceStage: (s) => handleNightAdvanceStage(s),
	NightAnnounceResults: (s) => handleNightAnnounceResults(s),
	NightPass: (s) => handleNightPass(s),
	NightConfirmStage: (s) => handleNightConfirmStage(s),
	NightNarrationStarted: (s, a) => handleNightNarrationStarted(s, a.role),
	DayNextSpeaker: (s) => handleNextSpeaker(s),
	DayBeginVote: (s) => handleBeginVote(s),
	DayEndDay: (s) => handleEndDay(s),
	DayExile: (s, a) => handleExile(s, a.seat),
	DayOut: (s, a) => handleDayOut(s, a.seats),
	DaySelfExplode: (s, a) => handleSelfExplode(s, a.seat),
	DayKnightDuel: (s, a) => handleKnightDuel(s, a.knightSeat, a.targetSeat),
	VoteCast: (s, a) => handleVoteCast(s, a.target),
	VoteEnd: (s) => handleVoteEnd(s),
	HunterShoot: (s, a) => handleHunterShoot(s, a.target),
	HostOverride: (s, a) => handleHostOverride(s, a.overrideKind, a.seat, a.role)
};

export async function dispatchAction(
	socket: GameSocket,
	action: ClientAction
): Promise<ActionReply> {
	if (!(await checkRateLimit(socket.data.sessionId))) {
		return refuse('rate_limited');
	}
	try {
		const handler = HANDLERS[action.kind] as Handler<ActionKind>;
		return await handler(socket, action);
	} catch (err) {
		if (err instanceof ActionError) return { ok: false, error: err.code };
		throw err;
	}
}
