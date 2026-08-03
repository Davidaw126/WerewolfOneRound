import { readRoomHash } from './rooms/roomRepo';
import { setSessionRoom } from './session';

/**
 * A session's roomCode is "sticky" by design (so a mid-game refresh or
 * navigating to `/` sends you straight back into your active game) - but
 * that stickiness has no natural end once the room is gone or finished,
 * since nothing clears it except the explicit RoomLeave action from the
 * game-over screen. Any other way of navigating away (typing /lobby in the
 * URL bar, reopening the tab, a stale link) left players stuck being
 * redirected into a room they had no way to leave.
 *
 * Resolves what a session's roomCode should redirect to right now: the room
 * itself if it still exists and isn't finished, otherwise null - and, as a
 * side effect, clears the stale roomCode from the session so this doesn't
 * need to be re-resolved on every subsequent request.
 */
export async function resolveActiveRoomCode(
	sessionId: string,
	roomCode: string | null
): Promise<string | null> {
	if (!roomCode) return null;

	const room = await readRoomHash(roomCode);
	if (!room || room.phase === 'GAME_OVER') {
		await setSessionRoom(sessionId, null);
		return null;
	}

	return roomCode;
}
