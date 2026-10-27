// M5: LAST_WORDS / DISCUSSION queue advancement + the two host-initiated day
// events (自爆/骑士决斗) the spec keeps resident on the DISCUSSION screen -
// see engine.ts's SELF_EXPLODE/KNIGHT_DUEL handlers for the actual rules.

import { runGameAction } from '../../game/gameSync';
import type { AckResponse } from '../../../shared/events';
import { requireRoomCode, requireHost, type GameSocket } from './helpers';

export async function handleNextSpeaker(socket: GameSocket): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	return runGameAction(code, { type: 'NEXT_SPEAKER' }, { ignored: 'invalid_phase' });
}

export async function handleBeginVote(socket: GameSocket): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	return runGameAction(code, { type: 'BEGIN_VOTE' }, { ignored: 'invalid_phase' });
}

export async function handleEndDay(socket: GameSocket): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	return runGameAction(code, { type: 'END_DAY' }, { ignored: 'invalid_phase' });
}

export async function handleExile(socket: GameSocket, seat: number): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	// The engine ignores an exile it can't apply (already decided today, a
	// dead or flipped seat) - say so instead of a silent no-op.
	return runGameAction(code, { type: 'EXILE', seat }, { ignored: 'cannot_exile' });
}

export async function handleDayOut(socket: GameSocket, seats: number[]): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	return runGameAction(code, { type: 'DAY_OUT', seats }, { ignored: 'cannot_mark_out' });
}

export async function handleSelfExplode(socket: GameSocket, seat: number): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	return runGameAction(code, { type: 'SELF_EXPLODE', seat }, { ignored: 'cannot_self_explode' });
}

export async function handleKnightDuel(
	socket: GameSocket,
	knightSeat: number,
	targetSeat: number
): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	return runGameAction(
		code,
		{ type: 'KNIGHT_DUEL', knightSeat, targetSeat },
		{ ignored: 'cannot_duel' }
	);
}
