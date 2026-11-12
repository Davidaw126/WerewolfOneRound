import { redirect } from '@sveltejs/kit';
import { roomExists } from '$lib/server/rooms/roomRepo';
import { setSessionRoom } from '$lib/server/session';
import { roomPath, roomPathFrom } from '$lib/shared/roomLink';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.session) {
		// A shared link or QR code: pick a name first, then come back here.
		const back = roomPathFrom(roomPath(params.code));
		redirect(307, back ? `/register?next=${encodeURIComponent(back)}` : '/register');
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
