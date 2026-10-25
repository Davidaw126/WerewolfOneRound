import {
	takeSeatAtomic,
	getPublicState,
	currentRoleOfSeat,
	markRevealed
} from '../../rooms/roomRepo';
import { emitToRoom, emitToSession } from '../emit';
import type { AckResponse } from '../../../shared/events';
import { requireRoomCode, requireSeat, type GameSocket } from './helpers';

export async function handleSeatTake(socket: GameSocket, seatNumber: number): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	const result = await takeSeatAtomic(
		code,
		socket.data.sessionId,
		seatNumber,
		socket.data.username
	);
	if (!result.ok) return result;

	const state = await getPublicState(code);
	if (state) emitToRoom(code, { kind: 'SeatUpdated', seats: state.seats });

	// Deliberately does NOT reveal the role here - that used to happen
	// automatically on sit, which let a player peek a seat's role and hop to
	// another seat to try for a different one. Revealing is now a separate,
	// explicit RevealRole action, and takeSeat.lua carries an already-dealt
	// role along with the player when they switch seats, so hopping can never
	// change what they eventually see.
	return { ok: true };
}

export async function handleRevealRole(socket: GameSocket): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	const seat = await requireSeat(code, socket.data.sessionId);

	const role = await currentRoleOfSeat(code, seat);
	if (!role) return { ok: false, error: 'no_role_assigned' };

	await markRevealed(code, socket.data.sessionId);
	emitToSession(socket.data.sessionId, { kind: 'YourRole', role });
	return { ok: true };
}
