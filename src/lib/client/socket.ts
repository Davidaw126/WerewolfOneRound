import { io, type Socket } from 'socket.io-client';
import type { ClientAction, AckResponse, ServerEvent, PrivateInfo } from '$lib/shared/events';

let socket: Socket | null = null;

/** Same-origin connection - the Socket.IO server is attached to the same
 * HTTP server SvelteKit itself runs on (see src/lib/server/socket), so no
 * separate URL/port is needed. Auth is via the httpOnly session cookie,
 * sent automatically by the browser on the handshake request. */
export function getSocket(): Socket {
	if (!socket) {
		socket = io();
	}
	return socket;
}

/** Tears down the current connection so the next `getSocket()` call opens a
 * fresh one. The server only reads the session cookie once, at the initial
 * handshake (see authMiddleware) - every action after that trusts whatever
 * identity got cached on the connection back then, with no re-validation.
 * Logging out and back in as someone else is an SPA navigation (no page
 * reload), so without this the old connection would just keep running under
 * the old, by-then-deleted session for the rest of the tab's lifetime. */
export function disconnectSocket(): void {
	if (socket) {
		socket.disconnect();
		socket = null;
	}
}

export function sendAction<T extends AckResponse = AckResponse>(action: ClientAction): Promise<T> {
	return new Promise((resolve) => {
		getSocket().emit('client:action', action, (res: T) => resolve(res));
	});
}

export function onServerEvent(handler: (event: ServerEvent) => void): () => void {
	const sock = getSocket();
	sock.on('server:event', handler);
	return () => sock.off('server:event', handler);
}

export function onPrivateEvent(handler: (event: PrivateInfo) => void): () => void {
	const sock = getSocket();
	sock.on('server:private', handler);
	return () => sock.off('server:private', handler);
}
