import type { Socket } from 'socket.io';
import type { SocketData } from '../types';
import { isHost, seatOf } from '../../rooms/roomRepo';
import { getSession } from '../../session';
import { ActionError } from '../actionError';

export type GameSocket = Socket<object, object, object, SocketData>;

export { ActionError };

/** The room this socket acts in. Checked against the session record, not
 * just the socket: a session that left (or was removed) from the room on
 * another tab or by the Host must not keep acting through an old socket. */
export async function requireRoomCode(socket: GameSocket): Promise<string> {
	const code = socket.data.roomCode;
	if (!code || (await getSession(socket.data.sessionId))?.roomCode !== code) {
		throw new ActionError('not_in_room');
	}
	return code;
}

export async function requireHost(code: string, sessionId: string): Promise<void> {
	if (!(await isHost(code, sessionId))) throw new ActionError('not_host');
}

export async function requireSeat(code: string, sessionId: string): Promise<number> {
	const seat = await seatOf(code, sessionId);
	if (seat === null) throw new ActionError('not_seated');
	return seat;
}
