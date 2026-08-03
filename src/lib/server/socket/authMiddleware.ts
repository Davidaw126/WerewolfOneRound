import type { Socket } from 'socket.io';
import { decodeCookieValue, getSession } from '../session';
import { SESSION_COOKIE_NAME } from '../cookieName';
import { roomChannel, sessionChannel } from './emit';
import type { SocketData } from './types';

/** Minimal `Cookie:` header parser - deliberately not the `cookie` npm
 * package: SvelteKit's own build depends on an older, incompatible version
 * of it (`parse`/`serialize`, vs. newer `parseCookie`/`stringifyCookie`),
 * and having both in the dependency tree causes npm's hoisting to shadow
 * one with the other, breaking SvelteKit's own internals at build time.
 * We only ever need to read our own httpOnly session cookie, so a full
 * RFC6265 parser is more machinery than this needs anyway. */
function parseCookieHeader(header: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq === -1) continue;
		const key = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim();
		if (!key) continue;
		try {
			out[key] = decodeURIComponent(value);
		} catch {
			out[key] = value;
		}
	}
	return out;
}

/**
 * Verifies the signed session cookie on the Socket.IO handshake and rejects
 * the connection outright if invalid - never trusts anything in the
 * handshake's `auth` payload for identity, only the httpOnly cookie already
 * set by the register/login HTTP flow.
 */
export function authMiddleware(
	socket: Socket<object, object, object, SocketData>,
	next: (err?: Error) => void
): void {
	(async () => {
		const cookieHeader = socket.handshake.headers.cookie;
		const cookies = cookieHeader ? parseCookieHeader(cookieHeader) : {};
		const sessionId = decodeCookieValue(cookies[SESSION_COOKIE_NAME]);
		if (!sessionId) {
			next(new Error('unauthorized'));
			return;
		}

		const session = await getSession(sessionId);
		if (!session) {
			next(new Error('unauthorized'));
			return;
		}

		socket.data.sessionId = sessionId;
		socket.data.username = session.username;
		socket.data.roomCode = session.roomCode;

		socket.join(sessionChannel(sessionId));
		if (session.roomCode) {
			socket.join(roomChannel(session.roomCode));
		}

		next();
	})().catch((err) => next(err instanceof Error ? err : new Error('auth_failed')));
}
