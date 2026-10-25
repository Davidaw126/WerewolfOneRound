// M5: LAST_WORDS / DISCUSSION queue advancement + the two host-initiated day
// events (自爆/骑士决斗) the spec keeps resident on the DISCUSSION screen -
// see engine.ts's SELF_EXPLODE/KNIGHT_DUEL handlers for the actual rules.

import { applyGameAction } from '../../game/gameStateRepo';
import { syncAndBroadcast } from '../../game/gameSync';
import type { AckResponse } from '../../../shared/events';
import { requireRoomCode, requireHost, type GameSocket } from './helpers';

export async function handleNextSpeaker(socket: GameSocket): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	const { result, previousLegacyPhase } = await applyGameAction(
		code,
		{ type: 'NEXT_SPEAKER' },
		Date.now()
	);
	if (result.effects.length === 0) return { ok: false, error: 'invalid_phase' };
	await syncAndBroadcast(code, result, previousLegacyPhase);
	return { ok: true };
}

export async function handleBeginVote(socket: GameSocket): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	const { result, previousLegacyPhase } = await applyGameAction(
		code,
		{ type: 'BEGIN_VOTE' },
		Date.now()
	);
	if (result.effects.length === 0) return { ok: false, error: 'invalid_phase' };
	await syncAndBroadcast(code, result, previousLegacyPhase);
	return { ok: true };
}

export async function handleEndDay(socket: GameSocket): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	const { result, previousLegacyPhase } = await applyGameAction(
		code,
		{ type: 'END_DAY' },
		Date.now()
	);
	if (result.effects.length === 0) return { ok: false, error: 'invalid_phase' };
	await syncAndBroadcast(code, result, previousLegacyPhase);
	return { ok: true };
}

export async function handleExile(socket: GameSocket, seat: number): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	const { result, previousLegacyPhase } = await applyGameAction(
		code,
		{ type: 'EXILE', seat },
		Date.now()
	);
	// The engine ignores an exile it can't apply (already decided today, a
	// dead or flipped seat) - say so instead of a silent no-op.
	if (result.effects.length === 0) return { ok: false, error: 'cannot_exile' };
	await syncAndBroadcast(code, result, previousLegacyPhase);
	return { ok: true };
}

export async function handleDayOut(socket: GameSocket, seats: number[]): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	const { result, previousLegacyPhase } = await applyGameAction(
		code,
		{ type: 'DAY_OUT', seats },
		Date.now()
	);
	if (result.effects.length === 0) return { ok: false, error: 'cannot_mark_out' };
	await syncAndBroadcast(code, result, previousLegacyPhase);
	return { ok: true };
}

export async function handleSelfExplode(socket: GameSocket, seat: number): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	const { result, previousLegacyPhase } = await applyGameAction(
		code,
		{ type: 'SELF_EXPLODE', seat },
		Date.now()
	);
	if (result.effects.length === 0) return { ok: false, error: 'cannot_self_explode' };
	await syncAndBroadcast(code, result, previousLegacyPhase);
	return { ok: true };
}

export async function handleKnightDuel(
	socket: GameSocket,
	knightSeat: number,
	targetSeat: number
): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	const { result, previousLegacyPhase } = await applyGameAction(
		code,
		{ type: 'KNIGHT_DUEL', knightSeat, targetSeat },
		Date.now()
	);
	if (result.effects.length === 0) return { ok: false, error: 'cannot_duel' };
	await syncAndBroadcast(code, result, previousLegacyPhase);
	return { ok: true };
}
