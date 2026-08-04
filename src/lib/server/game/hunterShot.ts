import { redis } from '../redis';
import { roomKey } from '../rooms/keys';
import { findSessionInSeat, touchRoomTtl } from '../rooms/roomRepo';
import { emitToRoom, emitToSession } from '../socket/emit';

/**
 * Transitions the room into a hunter-shot phase (night or day variant) and
 * notifies everyone: the room learns a hunter died and needs to decide, the
 * hunter's own session gets private authorization to actually shoot. Shared
 * by resolveNight (a wolf kill/witch poison took the hunter) and tallyVotes
 * (the day vote eliminated the hunter) - the two call sites were previously
 * near-identical inline blocks differing only in which phase/hunterSeat/
 * phaseAfterHunterShot applied.
 */
export async function enterHunterShotPhase(
	code: string,
	params: {
		phase: 'NIGHT_HUNTER_SHOT' | 'DAY_HUNTER_SHOT';
		hunterSeat: number;
		phaseAfterHunterShot: 'DAY_VOTE' | 'NEXT_NIGHT';
		nightNumber: number;
	}
): Promise<void> {
	const { phase, hunterSeat, phaseAfterHunterShot, nightNumber } = params;

	await redis.hset(roomKey(code), {
		phase,
		hunterShotSeat: String(hunterSeat),
		hunterShotResolved: '0',
		phaseAfterHunterShot
	});
	await touchRoomTtl(code);
	emitToRoom(code, { kind: 'PhaseChanged', phase, nightNumber });
	emitToRoom(code, { kind: 'HunterPending', hunterSeat });

	const shooter = await findSessionInSeat(code, hunterSeat);
	if (shooter) emitToSession(shooter, { kind: 'HunterAuthorized' });
}
