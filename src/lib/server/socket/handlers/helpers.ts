import type { Socket } from 'socket.io';
import type { SocketData } from '../types';
import { readRoomHash, seatOf } from '../../rooms/roomRepo';

export type GameSocket = Socket<object, object, object, SocketData>;

export class ActionError extends Error {}

export function requireRoomCode(socket: GameSocket): string {
	if (!socket.data.roomCode) throw new ActionError('not_in_room');
	return socket.data.roomCode;
}

export async function requireHost(code: string, sessionId: string): Promise<void> {
	const room = await readRoomHash(code);
	if (!room || room.hostSessionId !== sessionId) throw new ActionError('not_host');
}

export async function requireSeat(code: string, sessionId: string): Promise<number> {
	const seat = await seatOf(code, sessionId);
	if (seat === null) throw new ActionError('not_seated');
	return seat;
}
