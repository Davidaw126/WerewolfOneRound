// Room operations: each one changes the Room (roomRepo) and tells whoever
// needs to hear about it - the pre-game counterpart of gameSync's
// runGameAction. Handlers only say who is asking (and keep the socket's own
// channel bookkeeping); what changes and who is told what lives here, one
// function per operation, tested with a fake io (roomOps.spec.ts).

import {
	createRoom,
	readRoomHash,
	belongsToRoom,
	submitRoomConfigAtomic,
	seatingForGameStart,
	setSeatsLocked,
	redeal,
	resetToSeating,
	asHost,
	isHost,
	leaveRoom,
	takeSeatAtomic,
	seatOf,
	currentRoleOfSeat,
	markRevealed,
	getPublicState,
	getRevealedRoleIfAny
} from './roomRepo';
import { setSessionRoom, touchSession } from '../session';
import { emitToRoom, emitToSession, removeSessionFromRoom } from '../socket/emit';
import { startGameAndBroadcast } from '../game/gameSync';
import { replayGameInfo } from '../game/turnReplay';
import { withRoomLock } from '../game/gameStateRepo';
import { buildSetup, validateSetup } from '../../game/rules/setup';
import { deriveSeatCount, type DealResult } from '../../game/rules/deal';
import { defaultRuleConfig } from '../../game/defaultRuleConfig';
import { mergeRuleConfig, type RuleConfigOverrides } from '../../game/ruleSwitches';
import type { StartGameParams } from '../../game/engine';
import type { RoleId } from '../../game/types';
import { refuse, type AckResponse, type ActionReply, type Refusal } from '../../shared/events';
import { PRE_GAME_PHASES, type RoomPublicState } from '../../shared/gameTypes';

/** Opens a room with `sessionId` as its Host, and puts them in it. */
export async function openRoom(sessionId: string): Promise<ActionReply<'RoomCreate'>> {
	const code = await createRoom(sessionId);
	await setSessionRoom(sessionId, code);
	const state = await getPublicState(code, sessionId);
	if (!state) return refuse('room_not_found');
	return { ok: true, roomCode: code, state };
}

/** Puts `sessionId` in the room and catches it up. Once the seats are
 * locked or a game is on, only someone who already belongs (the Host, a
 * seated player) gets in - a room-code guesser mustn't sit in on a game. */
export async function enterRoom(code: string, sessionId: string): Promise<ActionReply<'RoomJoin'>> {
	const room = await readRoomHash(code);
	if (!room) return refuse('room_not_found');
	const closed = room.lockStatus || !PRE_GAME_PHASES.includes(room.phase);
	if (closed && !(await belongsToRoom(code, sessionId))) return refuse('room_locked');
	await setSessionRoom(sessionId, code);
	return catchUp(code, sessionId);
}

/** The room as it is now for this session, with everything private it's
 * owed sent again (before the game, its role if it already looked) - the one
 * replay path, for entering and for coming back from a dropped connection
 * or the background alike. */
export async function catchUp(
	code: string,
	sessionId: string
): Promise<{ ok: true; state: RoomPublicState } | Refusal> {
	// Still here: keep the login alive (a socket never renews it otherwise).
	touchSession(sessionId).catch(() => {});
	// Under the room lock, so the state and what's replayed are one moment
	// of the room - never half a stop, a Re-deal or a stage change.
	return withRoomLock(code, async () => {
		const state = await getPublicState(code, sessionId);
		if (!state) return refuse('room_not_found');
		if (!(await replayGameInfo(code, sessionId))) {
			const revealedRole = await getRevealedRoleIfAny(code, sessionId);
			if (revealedRole) emitToSession(sessionId, { kind: 'YourRole', role: revealedRole });
		}
		return { ok: true as const, state };
	});
}

/** The Host's role setup: dealt, and the room moves to SEATING. */
export async function submitConfig(
	code: string,
	sessionId: string,
	submitted: Partial<Record<RoleId, number>>,
	ruleOverrides: RuleConfigOverrides = {}
): Promise<ActionReply<'RoomSubmitConfig'>> {
	// Only roles actually in play are kept (the picker sends zeros too).
	const roleConfig: Partial<Record<RoleId, number>> = {};
	for (const [role, count] of Object.entries(submitted) as [RoleId, number][]) {
		if (count > 0) roleConfig[role] = count;
	}
	const numberOfSeats = deriveSeatCount(roleConfig);
	if (numberOfSeats <= 0) return refuse('empty_config');

	// §5.2's composition checks. E01 (roles vs. players seated) waits for the
	// start, when there's a real headcount.
	const validation = validateSetup(buildSetup(roleConfig), numberOfSeats);
	if (!validation.ok) return refuse(validation.errors[0].code, validation.errors);

	// Checks the Host atomically with the write.
	const result = await submitRoomConfigAtomic(code, sessionId, {
		roleConfig,
		numberOfSeats,
		ruleOverrides
	});
	if (!result.ok) return result;

	// The submit also deals, moves the phase and clears the seats: a full
	// snapshot keeps phones from missing any one of those.
	await announceState(code);
	return { ok: true, issues: validation.warnings.length > 0 ? validation.warnings : undefined };
}

export async function takeSeat(
	code: string,
	sessionId: string,
	seat: number,
	username: string
): Promise<AckResponse> {
	const result = await takeSeatAtomic(code, sessionId, seat, username);
	if (!result.ok) return result;
	await announceSeats(code);
	// The role is NOT revealed on sitting down (that let a player peek a
	// seat's role and hop to another); a dealt role moves with the player
	// when they switch seats, and revealing is its own action.
	return { ok: true };
}

/** Shows the player the role dealt to their seat - to them alone. */
export async function revealRole(code: string, sessionId: string): Promise<AckResponse> {
	// Under the room lock, so a Re-deal can't land between reading the card and
	// telling the phone: the old card would arrive after the news that it's
	// gone, and the phone would show it until the game started.
	return withRoomLock(code, async () => {
		const seat = await seatOf(code, sessionId);
		if (seat === null) return refuse('not_seated');
		const role = await currentRoleOfSeat(code, seat);
		if (!role) return refuse('no_role_assigned');
		await markRevealed(code, sessionId);
		emitToSession(sessionId, { kind: 'YourRole', role });
		return { ok: true };
	});
}

export async function rerollRoles(code: string, sessionId: string): Promise<AckResponse> {
	const done = await asHost(code, sessionId, async () => {
		const room = await readRoomHash(code);
		if (room?.phase !== 'SEATING') return refuse('invalid_phase');
		await redeal(code);
		emitToRoom(code, { kind: 'RolesRerolled' });
		return null;
	});
	return done ?? { ok: true };
}

/** Start game, in one step: under the room lock the seats are locked, the
 * setup is checked against who is actually seated, and the game is dealt.
 * A refused start leaves the seats open again - nothing is half-done if the
 * Host's phone dies along the way. */
export async function startGame(code: string, sessionId: string): Promise<AckResponse> {
	const reply = await startGameAndBroadcast(code, async () => {
		if (!(await isHost(code, sessionId))) return refuse('not_host');
		const room = await readRoomHash(code);
		if (room?.phase !== 'SEATING') return refuse('invalid_phase');
		// Locked first, so the seating read below is the one that starts.
		await setSeatsLocked(code, true);
		const params = await startGameParams(code);
		const validation = params && validateSetup(params.setup, params.players.length);
		if (!params || !validation || !validation.ok) {
			await setSeatsLocked(code, false);
			return validation
				? refuse(validation.errors[0].code, validation.errors)
				: refuse('room_not_found');
		}
		// Every player needs a card: a seat the deal doesn't cover would start
		// the game with no role at all.
		if (params.players.some((p) => !params.deal.identities[String(p.seat)])) {
			await setSeatsLocked(code, false);
			return refuse('no_role_assigned');
		}
		return params;
	});
	if (reply.ok) emitToRoom(code, { kind: 'LockUpdated', locked: true });
	return reply;
}

/** The engine's StartGameParams from what seating dealt and who sat down. */
async function startGameParams(code: string): Promise<StartGameParams | null> {
	const seating = await seatingForGameStart(code);
	if (!seating) return null;
	const { room, identities, seated } = seating;

	const seatRoles: Record<string, RoleId> = {};
	const buriedRoles: RoleId[] = [];
	for (const [slot, role] of Object.entries(identities)) {
		if (slot === 'buried1' || slot === 'buried2') buriedRoles.push(role);
		else seatRoles[slot] = role;
	}
	const buried: [RoleId, RoleId] | null =
		buriedRoles.length === 2 ? [buriedRoles[0], buriedRoles[1]] : null;

	const roleCounts: Partial<Record<RoleId, number>> = {};
	for (const role of [...Object.values(seatRoles), ...(buried ?? [])]) {
		roleCounts[role] = (roleCounts[role] ?? 0) + 1;
	}

	const deal: DealResult = { identities: seatRoles, buried };
	return {
		roomCode: code,
		ruleConfig: mergeRuleConfig(defaultRuleConfig(), room.ruleOverrides),
		setup: buildSetup(roleCounts),
		deal,
		players: seated.map((p) => ({
			seat: p.seat,
			sessionId: p.sessionId,
			nickname: p.username || `Seat ${p.seat}`
		})),
		now: Date.now()
	};
}

/** The Host's 结束游戏 / 再来一局: back to SEATING with the same setup. */
export async function stopGame(code: string, sessionId: string): Promise<AckResponse> {
	const done = await asHost(code, sessionId, async () => {
		const room = await readRoomHash(code);
		if (!room || room.phase === 'LOBBY') return refuse('invalid_phase');
		await resetToSeating(code);
		await announceBackToSeating(code);
		return null;
	});
	return done ?? { ok: true };
}

/** Leave (see GLOSSARY.md): the Host leaving closes the room; a player
 * leaving mid-round ends the round for everyone; before a game it frees
 * their seat (and re-deals if they had seen their role). Every phone of the
 * leaving session is told and taken out of the room's channel. */
export async function leave(code: string, sessionId: string): Promise<AckResponse> {
	const outcome = await leaveRoom(code, sessionId);
	switch (outcome.kind) {
		case 'closed':
			emitToRoom(code, { kind: 'RoomClosed', reason: 'host_left' });
			break;
		case 'round_ended':
			await announceBackToSeating(code);
			emitToRoom(code, { kind: 'ErrorToast', reason: 'player_left_mid_game', seat: outcome.seat });
			break;
		case 'left':
			if (outcome.vacated) await announceSeats(code);
			if (outcome.redealt) emitToRoom(code, { kind: 'RolesRerolled', reason: 'seen_role_left' });
			break;
	}
	await setSessionRoom(sessionId, null);
	emitToSession(sessionId, { kind: 'RemovedFromRoom', reason: 'left' });
	removeSessionFromRoom(sessionId, code);
	return { ok: true };
}

async function announceState(code: string): Promise<void> {
	const state = await getPublicState(code);
	if (state) emitToRoom(code, { kind: 'StateSnapshot', state });
}

async function announceSeats(code: string): Promise<void> {
	const state = await getPublicState(code);
	if (state) emitToRoom(code, { kind: 'SeatUpdated', seats: state.seats });
}

/** Back to SEATING (resetToSeating) - after the Host's stop, or a player's
 * mid-round Leave. */
async function announceBackToSeating(code: string): Promise<void> {
	await announceState(code);
	emitToRoom(code, { kind: 'GameReset' });
}
