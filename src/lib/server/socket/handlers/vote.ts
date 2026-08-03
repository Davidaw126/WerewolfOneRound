import { castVote, tallyVotes } from '../../game/stateMachine';
import { readRoomHash } from '../../rooms/roomRepo';
import type { AckResponse } from '../../../shared/events';
import { requireRoomCode, requireSeat, requireHost, type GameSocket } from './helpers';

export async function handleVoteCast(
	socket: GameSocket,
	target: number | 'abstain'
): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	const seat = await requireSeat(code, socket.data.sessionId);

	// Voting only opens once the host has announced last night's outcome -
	// otherwise players would be discussing/voting on information (who's
	// dead) they haven't officially been told yet.
	const room = await readRoomHash(code);
	if (!room || room.pendingNightDeaths !== null) return { ok: false, error: 'night_not_announced' };

	await castVote(code, seat, target);
	return { ok: true };
}

export async function handleVoteEnd(socket: GameSocket): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);

	const room = await readRoomHash(code);
	if (!room || room.pendingNightDeaths !== null) return { ok: false, error: 'night_not_announced' };

	await tallyVotes(code);
	return { ok: true };
}
