// M6 §10.5 上帝之手 - host-only manual override, reachable any time a game is
// in progress. The engine's own HOST_OVERRIDE handler (engine.ts) does the
// actual state mutation; this is just the auth + wire-shape bridge, same
// split as every other handler in this directory.

import { applyGameAction } from '../../game/gameStateRepo';
import { syncAndBroadcast } from '../../game/gameSync';
import { legacyToRoleId } from '../../../game/roleBridge';
import type { AckResponse } from '../../../shared/events';
import type { Role } from '../../../shared/roles';
import { requireRoomCode, requireHost, ActionError, type GameSocket } from './helpers';

export async function handleHostOverride(
	socket: GameSocket,
	overrideKind: 'KILL' | 'REVIVE' | 'SET_ROLE',
	seat: number,
	role?: Role
): Promise<AckResponse> {
	const code = requireRoomCode(socket);
	await requireHost(code, socket.data.sessionId);

	let roleId = undefined;
	if (overrideKind === 'SET_ROLE') {
		if (!role) throw new ActionError('missing_role');
		roleId = legacyToRoleId(role) ?? undefined;
		if (!roleId) throw new ActionError('unsupported_role');
	}

	const { result, previousLegacyPhase } = await applyGameAction(
		code,
		{ type: 'HOST_OVERRIDE', kind: overrideKind, seat, role: roleId },
		Date.now()
	);
	await syncAndBroadcast(code, result, previousLegacyPhase);
	return { ok: true };
}
