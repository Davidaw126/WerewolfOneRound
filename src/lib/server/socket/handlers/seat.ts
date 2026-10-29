import * as ops from '../../rooms/roomOps';
import type { AckResponse } from '../../../shared/events';
import { requireRoomCode, type GameSocket } from './helpers';

export async function handleSeatTake(socket: GameSocket, seatNumber: number): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	return ops.takeSeat(code, socket.data.sessionId, seatNumber, socket.data.username);
}

export async function handleRevealRole(socket: GameSocket): Promise<AckResponse> {
	return ops.revealRole(await requireRoomCode(socket), socket.data.sessionId);
}
