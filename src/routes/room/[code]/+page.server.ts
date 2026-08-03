import { redirect } from '@sveltejs/kit';
import { roomExists } from '$lib/server/rooms/roomRepo';
import { setSessionRoom } from '$lib/server/session';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.session) {
		redirect(307, '/register');
	}
	if (!(await roomExists(params.code))) {
		// If the session was still pointing at this now-gone room, clear it -
		// otherwise /lobby's own guard would just redirect straight back here.
		if (locals.session.roomCode === params.code) {
			await setSessionRoom(locals.session.sessionId, null);
		}
		redirect(307, '/lobby');
	}
	return {
		username: locals.session.username,
		sessionId: locals.session.sessionId,
		roomCode: params.code
	};
};
