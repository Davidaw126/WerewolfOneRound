import type { Server } from 'socket.io';
import type { ServerEvent, PrivateInfo } from '../../shared/events';

let ioInstance: Server | null = null;

export function setIoInstance(io: Server): void {
	ioInstance = io;
}

function requireIo(): Server {
	if (!ioInstance) throw new Error('Socket.IO server not initialized yet');
	return ioInstance;
}

export const roomChannel = (roomCode: string) => `room:${roomCode}`;
export const sessionChannel = (sessionId: string) => `session:${sessionId}`;

export function emitToRoom(roomCode: string, event: ServerEvent): void {
	requireIo().to(roomChannel(roomCode)).emit('server:event', event);
}

export function emitToSession(sessionId: string, event: PrivateInfo): void {
	requireIo().to(sessionChannel(sessionId)).emit('server:private', event);
}

/** Takes every phone of this session out of the room's broadcast channel -
 * the caller's own socket and any other tab or device, on any server
 * instance. Used when someone leaves the room (and by a Kick). */
export function removeSessionFromRoom(sessionId: string, roomCode: string): void {
	requireIo().in(sessionChannel(sessionId)).socketsLeave(roomChannel(roomCode));
}
