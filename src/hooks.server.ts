import type { Handle } from '@sveltejs/kit';
import { decodeCookieValue, getSession, touchSession } from '$lib/server/session';
import { SESSION_COOKIE_NAME } from '$lib/server/cookieName';

export const handle: Handle = async ({ event, resolve }) => {
	const cookieValue = event.cookies.get(SESSION_COOKIE_NAME);
	const sessionId = decodeCookieValue(cookieValue);

	if (sessionId) {
		const session = await getSession(sessionId);
		if (session) {
			event.locals.session = {
				sessionId,
				username: session.username,
				roomCode: session.roomCode
			};
			// Fire-and-forget: don't block the request on refreshing the TTL.
			touchSession(sessionId).catch(() => {});
		}
	}

	return resolve(event);
};
