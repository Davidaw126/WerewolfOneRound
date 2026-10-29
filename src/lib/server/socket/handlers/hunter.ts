import { runGameAction } from '../../game/gameSync';
import { hunterSeatOf } from '../../game/projection';
import { refuse, type AckResponse } from '../../../shared/events';
import { requireRoomCode, requireSeat, type GameSocket } from './helpers';

export async function handleHunterShoot(
	socket: GameSocket,
	target: number | null
): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	const seat = await requireSeat(code, socket.data.sessionId);

	// Checked under the per-room lock, so a second submit from the same seat
	// after the first succeeded finds pendingShoots already advanced past
	// them - no separate exactly-once guard needed.
	return runGameAction(code, (state) =>
		hunterSeatOf(state) === seat
			? { type: 'HUNTER_SHOOT', shooterSeat: seat, targetSeat: target }
			: refuse('not_authorized_shooter')
	);
}
