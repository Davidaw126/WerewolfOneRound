import { createHmac, timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';
import { requireSessionSecret } from './env';
import { redis } from './redis';

// Longer than any evening of play. It was 6h, the same as a room - but a
// room's life is renewed by every game action and a login's wasn't, so 6h
// after registering a phone that locked and reconnected was turned away
// mid-game. The cookie carries the same life and is renewed on every page
// request (hooks.server.ts); the record is also renewed whenever a phone
// connects or catches up.
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** How the session cookie is set - at registration and on every renewal. */
export function sessionCookieOptions() {
	return {
		path: '/',
		httpOnly: true,
		sameSite: 'lax' as const,
		secure: process.env.NODE_ENV === 'production',
		maxAge: SESSION_TTL_SECONDS
	};
}

function sign(sessionId: string): string {
	return createHmac('sha256', requireSessionSecret()).update(sessionId).digest('hex');
}

export function encodeCookieValue(sessionId: string): string {
	return `${sessionId}.${sign(sessionId)}`;
}

/** Verifies the HMAC signature and returns the sessionId, or null if invalid/tampered. */
export function decodeCookieValue(value: string | undefined | null): string | null {
	if (!value) return null;
	const dotIndex = value.indexOf('.');
	if (dotIndex === -1) return null;
	const sessionId = value.slice(0, dotIndex);
	const signature = value.slice(dotIndex + 1);
	if (!sessionId || !signature) return null;

	const expected = sign(sessionId);
	const a = Buffer.from(signature);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	return sessionId;
}

export interface SessionRecord {
	username: string;
	roomCode: string | null;
}

const sessionKey = (id: string) => `wolf:session:${id}`;
const usernameKey = (username: string) => `wolf:username:${username}`;

// Only releases the username reservation if it still points at the given
// session - guards against a race where the name was already reclaimed by a
// different session by the time this runs.
const RELEASE_USERNAME_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
	redis.call('DEL', KEYS[1])
end
return 1
`;

/**
 * Claims the username exclusively (atomic SET NX) before creating the
 * session, so two active sessions can never hold the same display name at
 * once. Returns null if the name is already taken by another live session.
 */
export async function createSession(
	username: string
): Promise<{ sessionId: string; cookieValue: string } | null> {
	const sessionId = nanoid();
	const claimed = await redis.set(
		usernameKey(username),
		sessionId,
		'EX',
		SESSION_TTL_SECONDS,
		'NX'
	);
	if (claimed !== 'OK') return null;

	await redis.hset(sessionKey(sessionId), { username, roomCode: '' });
	await redis.expire(sessionKey(sessionId), SESSION_TTL_SECONDS);
	return { sessionId, cookieValue: encodeCookieValue(sessionId) };
}

/** Ends a session entirely and releases its username so it can be reused. */
export async function destroySession(sessionId: string): Promise<void> {
	const session = await getSession(sessionId);
	await redis.del(sessionKey(sessionId));
	if (session) {
		await redis.eval(RELEASE_USERNAME_LUA, 1, usernameKey(session.username), sessionId);
	}
}

export async function getSession(sessionId: string): Promise<SessionRecord | null> {
	const data = await redis.hgetall(sessionKey(sessionId));
	if (!data.username) return null;
	return { username: data.username, roomCode: data.roomCode || null };
}

export async function setSessionRoom(sessionId: string, roomCode: string | null): Promise<void> {
	await redis.hset(sessionKey(sessionId), 'roomCode', roomCode ?? '');
	await redis.expire(sessionKey(sessionId), SESSION_TTL_SECONDS);
}

// Refreshes the username reservation's TTL alongside the session's own -
// otherwise the reservation would hard-expire 6h after registration even for
// a session still in active use, silently freeing the name for reuse while
// the original user is still logged in under it.
export async function touchSession(sessionId: string): Promise<void> {
	const username = await redis.hget(sessionKey(sessionId), 'username');
	await redis.expire(sessionKey(sessionId), SESSION_TTL_SECONDS);
	if (username) await redis.expire(usernameKey(username), SESSION_TTL_SECONDS);
}
