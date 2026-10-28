// M5: LAST_WORDS / DISCUSSION queue advancement + the two host-initiated day
// events (自爆/骑士决斗) the spec keeps resident on the DISCUSSION screen -
// see engine.ts's SELF_EXPLODE/KNIGHT_DUEL handlers for the actual rules.

import { runGameAction } from '../../game/gameSync';
import type { AckResponse } from '../../../shared/events';
import { requireRoomCode, type GameSocket } from './helpers';

export async function handleNextSpeaker(socket: GameSocket): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	return runGameAction(
		code,
		{ type: 'NEXT_SPEAKER' },
		{ ignored: 'invalid_phase', host: socket.data.sessionId }
	);
}

export async function handleBeginVote(socket: GameSocket): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	return runGameAction(
		code,
		{ type: 'BEGIN_VOTE' },
		{ ignored: 'invalid_phase', host: socket.data.sessionId }
	);
}

export async function handleEndDay(socket: GameSocket): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	return runGameAction(
		code,
		{ type: 'END_DAY' },
		{ ignored: 'invalid_phase', host: socket.data.sessionId }
	);
}

export async function handleExile(socket: GameSocket, seat: number): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	// The engine ignores an exile it can't apply (already decided today, a
	// dead or flipped seat) - say so instead of a silent no-op.
	return runGameAction(
		code,
		{ type: 'EXILE', seat },
		{ ignored: 'cannot_exile', host: socket.data.sessionId }
	);
}

export async function handleDayOut(socket: GameSocket, seats: number[]): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	return runGameAction(
		code,
		{ type: 'DAY_OUT', seats },
		{ ignored: 'cannot_mark_out', host: socket.data.sessionId }
	);
}

export async function handleSelfExplode(socket: GameSocket, seat: number): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	return runGameAction(
		code,
		{ type: 'SELF_EXPLODE', seat },
		{ ignored: 'cannot_self_explode', host: socket.data.sessionId }
	);
}

export async function handleKnightDuel(
	socket: GameSocket,
	knightSeat: number,
	targetSeat: number
): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	return runGameAction(
		code,
		{ type: 'KNIGHT_DUEL', knightSeat, targetSeat },
		{ ignored: 'cannot_duel', host: socket.data.sessionId }
	);
}
