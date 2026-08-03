import { redirect } from '@sveltejs/kit';
import { resolveActiveRoomCode } from '$lib/server/roomGuard';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.session) {
		redirect(307, '/register');
	}
	const roomCode = await resolveActiveRoomCode(locals.session.sessionId, locals.session.roomCode);
	if (roomCode) {
		redirect(307, `/room/${roomCode}`);
	}
	return { username: locals.session.username };
};
