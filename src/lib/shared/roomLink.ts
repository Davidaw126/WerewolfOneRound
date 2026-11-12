// A room's shareable address: /room/<six digits>. Also the only place a
// fresh registration may be sent on to (register's `next`), so a link can't
// be made to bounce someone anywhere else.

const ROOM_PATH = /^\/room\/\d{6}$/;

export function roomPath(code: string): string {
	return `/room/${code}`;
}

/** `next` if it is a room's own path, otherwise null. */
export function roomPathFrom(next: string | null | undefined): string | null {
	return next && ROOM_PATH.test(next) ? next : null;
}
