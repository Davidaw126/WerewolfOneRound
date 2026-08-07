import { applyGameAction, loadGameState } from '../../game/gameStateRepo';
import { syncAndBroadcast } from '../../game/gameSync';
import { hunterSeatOf } from '../../game/projection';
import type { AckResponse } from '../../../shared/events';
import { requireRoomCode, requireSeat, type GameSocket } from './helpers';

export async function handleHunterShoot(
	socket: GameSocket,
	target: number | null
): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	const seat = await requireSeat(code, socket.data.sessionId);

	const state = await loadGameState(code);
	if (!state || hunterSeatOf(state) !== seat) {
		return { ok: false, error: 'not_authorized_shooter' };
	}

	// Per-room lock (gameStateRepo.ts) makes a genuine double-resolve
	// impossible - a second submit from the same seat after the first
	// succeeded finds pendingShoots already advanced past them, caught by the
	// same authorization check above on retry, so there's no separate
	// exactly-once guard needed here the way the old app's Lua script had.
	const { result, previousLegacyPhase } = await applyGameAction(
		code,
		{ type: 'HUNTER_SHOOT', shooterSeat: seat, targetSeat: target },
		Date.now()
	);
	await syncAndBroadcast(code, result, previousLegacyPhase);
	return { ok: true };
}
