import { readRoomHash, claimHunterShot } from '../../rooms/roomRepo';
import { resolveHunterShot } from '../../game/stateMachine';
import type { AckResponse } from '../../../shared/events';
import { requireRoomCode, requireSeat, type GameSocket } from './helpers';

export async function handleHunterShoot(
	socket: GameSocket,
	target: number | null
): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	const seat = await requireSeat(code, socket.data.sessionId);

	const room = await readRoomHash(code);
	if (!room || !room.hunterShotSeat || Number(room.hunterShotSeat) !== seat) {
		return { ok: false, error: 'not_authorized_shooter' };
	}

	const won = await claimHunterShot(code);
	if (!won) return { ok: false, error: 'already_resolved' };

	await resolveHunterShot(code, target);
	return { ok: true };
}
