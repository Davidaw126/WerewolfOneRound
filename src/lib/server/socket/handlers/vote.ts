import { runGameAction } from '../../game/gameSync';
import { refuse, type AckResponse } from '../../../shared/events';
import type { GameState } from '../../../game/types';
import { requireRoomCode, requireSeat, type GameSocket } from './helpers';

// Voting only opens once the host has announced last night's outcome -
// otherwise players would be discussing/voting on information (who's dead)
// they haven't officially been told yet. (The engine's own CAST_VOTE handler
// already no-ops outside phase VOTE for the same reason - this check exists
// so the client gets a real ack error instead of a silent no-op ok:true.)
const nightAnnounced = (state: GameState) => state.pendingNightDeaths === null;
const NOT_ANNOUNCED = refuse('night_not_announced');

export async function handleVoteCast(
	socket: GameSocket,
	target: number | 'abstain'
): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	const seat = await requireSeat(code, socket.data.sessionId);
	return runGameAction(code, (state) =>
		nightAnnounced(state)
			? { type: 'CAST_VOTE', seat, target: target === 'abstain' ? 'ABSTAIN' : target }
			: NOT_ANNOUNCED
	);
}

export async function handleVoteEnd(socket: GameSocket): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	return runGameAction(
		code,
		(state) =>
			nightAnnounced(state) ? { type: 'TALLY_VOTES', random: Math.random() } : NOT_ANNOUNCED,
		{ host: socket.data.sessionId }
	);
}
