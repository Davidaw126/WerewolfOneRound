import { redis } from '../../redis';
import { roomKey } from '../../rooms/keys';
import { getIdentities, readRoomHash, currentStageOf } from '../../rooms/roomRepo';
import { submitNightAction, hostAdvanceStage } from '../../game/stateMachine';
import { emitToRoom } from '../emit';
import type { AckResponse, NightActionSubmission } from '../../../shared/events';
import type { Role } from '../../../shared/roles';
import { requireRoomCode, requireSeat, requireHost, type GameSocket } from './helpers';

export async function handleNightSubmitAction(
	socket: GameSocket,
	action: NightActionSubmission
): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	const seat = await requireSeat(code, socket.data.sessionId);

	// The server-side role-match check that closed the old app's cheating
	// vector: a client can only ever submit an action for the role they were
	// actually dealt, never an arbitrary claimed role.
	const identities = await getIdentities(code);
	if (identities[String(seat)] !== action.role) {
		return { ok: false, error: 'not_your_role' };
	}

	// Distinct from the identity check above: that one is "are you who you say
	// you are", this is "do the rules allow what you're asking for".
	const result = await submitNightAction(code, seat, action);
	if (!result.ok) return { ok: false, error: result.error };
	return { ok: true };
}

export async function handleNightAdvanceStage(socket: GameSocket): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);
	await hostAdvanceStage(code);
	return { ok: true };
}

/** Relays "this role's narration line just started speaking" from the host's
 * device to the whole room, so every client's NightActionPrompt for that role
 * can stop waiting and actually show itself in sync with the voice - see
 * gameStore's pendingTurnRole. */
export async function handleNightNarrationStarted(
	socket: GameSocket,
	role: Role
): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);

	const room = await readRoomHash(code);
	const stage = room ? currentStageOf(room) : null;
	// Stale signal (e.g. the host manually advanced past this stage before
	// their queued narration line got around to playing) - don't resurrect a
	// prompt for a role that's no longer live.
	if (!stage || stage.kind !== 'ROLE_TURN' || stage.role !== role) return { ok: true };

	emitToRoom(code, { kind: 'StageNarrationStarted', role });
	return { ok: true };
}

export async function handleNightAnnounceResults(socket: GameSocket): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);

	const room = await readRoomHash(code);
	if (!room || room.pendingNightDeaths === null) return { ok: false, error: 'nothing_to_announce' };

	// Purely a reveal broadcast - the actual game state (dead seats, phase,
	// hunter-shot/win-check) was already resolved automatically the moment
	// the night's actions finished, so this never blocks or gates anything;
	// the host can press it whenever they like during the day.
	emitToRoom(code, {
		kind: 'NightResolved',
		nightNumber: room.nightNumber,
		deaths: room.pendingNightDeaths
	});
	await redis.hset(roomKey(code), { pendingNightDeaths: '' });

	return { ok: true };
}
