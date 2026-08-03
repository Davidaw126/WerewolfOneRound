import { json } from '@sveltejs/kit';
import { destroySession } from '$lib/server/session';
import { SESSION_COOKIE_NAME } from '$lib/server/cookieName';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, cookies }) => {
	if (locals.session) {
		await destroySession(locals.session.sessionId);
	}
	cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
	return json({ ok: true });
};
