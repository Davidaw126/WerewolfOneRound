import { applyGameAction, loadGameState } from '../../game/gameStateRepo';
import { syncAndBroadcast } from '../../game/gameSync';
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
	// dead) they haven't officially been told yet. (The engine's own CAST_VOTE
	// handler already no-ops outside phase VOTE for the same reason - this
	// check exists so the client gets a real ack error instead of a silent
	// no-op ok:true.)
	const state = await loadGameState(code);
	if (!state || state.pendingNightDeaths !== null) {
		return { ok: false, error: 'night_not_announced' };
	}

	const { result, previousLegacyPhase } = await applyGameAction(
		code,
		{ type: 'CAST_VOTE', seat, target: target === 'abstain' ? 'ABSTAIN' : target },
		Date.now()
	);
	await syncAndBroadcast(code, result, previousLegacyPhase);
	return { ok: true };
}

export async function handleVoteEnd(socket: GameSocket): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);

	const state = await loadGameState(code);
	if (!state || state.pendingNightDeaths !== null) {
		return { ok: false, error: 'night_not_announced' };
	}

	const { result, previousLegacyPhase } = await applyGameAction(
		code,
		{ type: 'TALLY_VOTES', random: Math.random() },
		Date.now()
	);
	await syncAndBroadcast(code, result, previousLegacyPhase);
	return { ok: true };
}
