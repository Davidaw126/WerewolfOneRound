import { redis } from '../redis';
import { nightActionsKey } from '../rooms/keys';
import {
	readRoomHash,
	getIdentities,
	getSeats,
	getDeadSeats,
	getCoupleSeats
} from '../rooms/roomRepo';
import { emitToSession } from '../socket/emit';
import type { Role } from '../../shared/roles';
import { roleTeam } from '../../shared/roles';
import { hunterCanShoot } from '../../shared/nightRules';
import type { NightActionSubmission, TurnContext } from '../../shared/events';

/** Reads one role's submission out of tonight's action hash. */
function readNightAction(
	rawActions: Record<string, string>,
	role: Role
): NightActionSubmission | null {
	const raw = rawActions[role];
	if (!raw) return null;
	return JSON.parse(raw) as NightActionSubmission;
}

/**
 * Wakes every living holder of `role` and hands them the private context their
 * turn needs - the app standing in for what a physical host would say aloud to
 * that player alone. This is the single place any turn context is computed.
 *
 * SECURITY: everything built here goes out via emitToSession (a per-session
 * channel) and must stay that way. The wolf teammate list in particular would
 * hand the entire wolf team to the village if it ever reached emitToRoom or
 * RoomPublicState.
 */
export async function notifyRoleHolders(
	code: string,
	role: Role,
	nightNumber: number
): Promise<void> {
	const [identities, seatsMap, deadSeats, room, rawActions] = await Promise.all([
		getIdentities(code),
		getSeats(code),
		getDeadSeats(code),
		readRoomHash(code),
		redis.hgetall(nightActionsKey(code, nightNumber))
	]);
	const deadSet = new Set(deadSeats);

	// The witch needs to know who the wolves killed tonight to decide whether
	// to use the antidote.
	const wolfAction = readNightAction(rawActions, '普通狼人');
	const killedSeat = wolfAction?.role === '普通狼人' ? wolfAction.targetSeat : null;

	// The hunter's stage always runs AFTER the witch's (see NIGHT1_ORDER and
	// REPEATING_ORDER), so tonight's poison target is already persisted by the
	// time we get here. If the witch is dead or her stage was skipped there's
	// no entry, poison is null, and hunterCanShoot short-circuits to true.
	let hunterContext: { canShoot: boolean } | undefined;
	if (role === '猎人') {
		const witchAction = readNightAction(rawActions, '女巫');
		const poisonSeat = witchAction?.role === '女巫' ? witchAction.poisonTarget : null;
		const coupleSeats = await getCoupleSeats(code);
		hunterContext = {
			canShoot: hunterCanShoot(
				identities,
				poisonSeat,
				coupleSeats,
				room?.cupidPoisonBlocksHunter ?? false
			)
		};
	}

	// Living wolf-team seats, for the wolves' own eyes only.
	// TODO 隐狼's whole premise is that even the other wolves don't know them,
	// but roleTeam() counts them as wolf-team. Harmless today (隐狼 has no
	// implemented mechanics and never gets a turn); revisit if it ever does.
	let wolfSeats: number[] = [];
	if (role === '普通狼人' || role === '狼美人') {
		for (const [seat, sessionId] of Object.entries(seatsMap)) {
			if (!sessionId) continue;
			if (deadSet.has(Number(seat))) continue;
			const seatRole = identities[seat];
			if (seatRole && roleTeam(seatRole) === 'wolf') wolfSeats.push(Number(seat));
		}
		wolfSeats = wolfSeats.sort((a, b) => a - b);
	}

	for (const [seat, sessionId] of Object.entries(seatsMap)) {
		if (!sessionId) continue;
		const seatNumber = Number(seat);
		if (deadSet.has(seatNumber)) continue;
		if (identities[seat] !== role) continue;

		const context: TurnContext = { seat: seatNumber };
		if (role === '女巫') {
			context.witch = {
				killedSeat,
				antidoteAvailable: !room?.witchUsedAntidote,
				poisonAvailable: !room?.witchUsedPoison
			};
		}
		if (role === '猎人') context.hunter = hunterContext;
		if (role === '守卫') context.guard = { lastProtectedSeat: room?.guardLastSeat ?? null };
		if (role === '普通狼人' || role === '狼美人') {
			context.wolf = { teammateSeats: wolfSeats.filter((s) => s !== seatNumber) };
		}

		emitToSession(sessionId, { kind: 'YourTurnPrompt', role, context });
		if (role === '盗贼') {
			const buried: [Role, Role] = [identities['buried1'], identities['buried2']];
			emitToSession(sessionId, { kind: 'ThiefChoice', buried });
		}
	}
}
