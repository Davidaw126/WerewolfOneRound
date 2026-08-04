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

	const response = await resolve(event);

	// CSP is set by SvelteKit itself (see the `csp` option passed to the
	// sveltekit() Vite plugin in vite.config.ts) - these are the response
	// headers that aren't part of SvelteKit's own CSP handling.
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	// No camera/mic/geolocation use anywhere in this app (speechSynthesis is
	// TTS output, not audio input).
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	// Same NODE_ENV gate as the session cookie's `secure` flag (register/+page.server.ts) -
	// harmless to send over plain HTTP (browsers ignore it there), but only
	// meaningful once the app is actually served over TLS.
	if (process.env.NODE_ENV === 'production') {
		response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	}

	return response;
};
