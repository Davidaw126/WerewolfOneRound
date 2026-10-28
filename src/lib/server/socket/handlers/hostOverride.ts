// M6 §10.5 上帝之手 - host-only manual override, reachable any time a game is
// in progress. The engine's own HOST_OVERRIDE handler (engine.ts) does the
// actual state mutation; this is just the auth + wire-shape bridge, same
// split as every other handler in this directory.

import { runGameAction } from '../../game/gameSync';
import type { AckResponse } from '../../../shared/events';
import type { RoleId } from '../../../game/types';
import { requireRoomCode, ActionError, type GameSocket } from './helpers';

export async function handleHostOverride(
	socket: GameSocket,
	overrideKind: 'KILL' | 'REVIVE' | 'SET_ROLE',
	seat: number,
	role?: RoleId
): Promise<AckResponse> {
	const code = await requireRoomCode(socket);
	if (overrideKind === 'SET_ROLE' && !role) throw new ActionError('missing_role');
	return runGameAction(
		code,
		{ type: 'HOST_OVERRIDE', kind: overrideKind, seat, role },
		{ host: socket.data.sessionId }
	);
}
