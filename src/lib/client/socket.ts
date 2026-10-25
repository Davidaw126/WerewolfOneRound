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

/** Long enough for a slow mobile network, short enough that a dead
 * connection doesn't leave a button that silently does nothing. */
const ACK_TIMEOUT_MS = 10_000;

let actionErrorHandler: ((error: string) => void) | null = null;

/** Registered once by the game store: every failed action (unless sent with
 * `quiet`) is reported here so the player always sees why nothing happened,
 * instead of a tap that silently does nothing. */
export function onActionError(handler: (error: string) => void): void {
	actionErrorHandler = handler;
}

/** `quiet`: the caller shows its own error UI (e.g. the lobby's inline
 * messages), or the action is background plumbing nobody tapped. */
export function sendAction<T extends AckResponse = AckResponse>(
	action: ClientAction,
	opts: { quiet?: boolean } = {}
): Promise<T> {
	return new Promise((resolve) => {
		const finish = (res: T) => {
			if (!res.ok && !opts.quiet) actionErrorHandler?.(res.error);
			resolve(res);
		};
		const sock = getSocket();
		const send = () =>
			sock
				.timeout(ACK_TIMEOUT_MS)
				.emit('client:action', action, (err: Error | null, res: T) =>
					finish(err ? ({ ok: false, error: 'timeout' } as T) : res)
				);
		if (sock.connected) return send();
		// Not connected yet (first load) or mid-reconnect: wait for it rather
		// than letting socket.io buffer the emit - a buffered emit would be
		// replayed on reconnect after we'd already reported a failure, so a
		// retry tap could apply the action twice.
		const timer = setTimeout(() => {
			sock.off('connect', onConnect);
			finish({ ok: false, error: 'disconnected' } as T);
		}, ACK_TIMEOUT_MS);
		const onConnect = () => {
			clearTimeout(timer);
			send();
		};
		sock.once('connect', onConnect);
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
