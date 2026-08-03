import { redis } from '../redis';
import {
	roomKey,
	identitiesKey,
	votesKey,
	coupleSeatsKey,
	nightActionsKey,
	deadSeatsKey,
	ROOM_TTL_SECONDS
} from '../rooms/keys';
import {
	readRoomHash,
	currentStageOf,
	getIdentities,
	getSeats,
	getDeadSeats,
	getVotes,
	getCoupleSeats,
	findSessionInSeat,
	advanceStageAtomic,
	touchRoomTtl,
	type RoomHashData
} from '../rooms/roomRepo';
import { emitToRoom, emitToSession } from '../socket/emit';
import type { Role } from '../../shared/roles';
import { buildNight1Order, buildRepeatingOrder, livingRolesFrom } from './nightOrder';
import { resolveNightDeaths, type NightActionInputs } from '../../shared/nightResolution';
import {
	hunterCanShoot,
	validateGuardAction,
	validateWitchAction,
	type NightRuleError
} from '../../shared/nightRules';
import { checkWin } from '../../shared/winCondition';
import { roleTeam } from '../../shared/roles';
import type { NightActionSubmission, TurnContext } from '../../shared/events';
import type { NightStage } from '../../shared/gameTypes';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function roleHasLivingHolder(code: string, role: Role): Promise<boolean> {
	const [identities, seatsMap, deadSeats] = await Promise.all([
		getIdentities(code),
		getSeats(code),
		getDeadSeats(code)
	]);
	const deadSet = new Set(deadSeats);
	for (const [seat, sessionId] of Object.entries(seatsMap)) {
		if (!sessionId) continue;
		if (deadSet.has(Number(seat))) continue;
		if (identities[seat] === role) return true;
	}
	return false;
}

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
async function notifyRoleHolders(code: string, role: Role, nightNumber: number): Promise<void> {
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

async function checkWinAndMaybeEnd(
	code: string,
	identities: Record<string, Role>
): Promise<boolean> {
	const [seatsMap, deadSeats] = await Promise.all([getSeats(code), getDeadSeats(code)]);
	const deadSet = new Set(deadSeats);
	const livingRoles: Role[] = [];
	for (const [seat, sessionId] of Object.entries(seatsMap)) {
		if (!sessionId) continue;
		if (deadSet.has(Number(seat))) continue;
		const role = identities[seat];
		if (role) livingRoles.push(role);
	}

	const winner = checkWin(livingRoles);
	if (!winner) return false;

	await redis.hset(roomKey(code), { phase: 'GAME_OVER', winner });
	await touchRoomTtl(code);

	const fullIdentities: Record<number, Role> = {};
	for (const [seat, role] of Object.entries(identities)) {
		if (seat.startsWith('buried')) continue;
		fullIdentities[Number(seat)] = role;
	}
	emitToRoom(code, { kind: 'GameOver', winner, identities: fullIdentities });
	return true;
}

/** Sets a fresh stage order (night 1 bootstrap or a new night), skipping past
 * any leading stage with zero living holders, then either enters the first
 * real stage or - if the whole order was empty/skippable - resolves the
 * night immediately as a "peaceful night". No CAS needed: only ever called
 * from a single sequential server-side flow, never raced by concurrent
 * client actions. */
async function enterStageOrder(
	code: string,
	stageOrder: NightStage[],
	nightNumber: number
): Promise<void> {
	let index = 0;
	while (index < stageOrder.length) {
		const stage = stageOrder[index];
		if (stage.kind === 'ROLE_TURN' && !(await roleHasLivingHolder(code, stage.role))) {
			index++;
			continue;
		}
		break;
	}

	await redis.hset(roomKey(code), {
		stageOrder: JSON.stringify(stageOrder),
		stageIndex: String(index)
	});
	await touchRoomTtl(code);

	const stage = stageOrder[index] ?? null;
	emitToRoom(code, { kind: 'StageChanged', stage });

	if (!stage) {
		await resolveNight(code);
	} else if (stage.kind === 'ROLE_TURN') {
		await notifyRoleHolders(code, stage.role, nightNumber);
	}
}

/** Advances within the current night's stageOrder, skipping stages with no
 * living holder, CAS-guarded since this IS raced by concurrent client
 * actions (an auto-trigger and a host force-skip can land in the same tick). */
async function advanceWithinNight(
	code: string,
	fromIndex: number,
	stageOrder: NightStage[],
	nightNumber: number
): Promise<void> {
	let index = fromIndex;
	while (true) {
		const newIndex = index + 1;
		const result = await advanceStageAtomic(code, index, newIndex);
		if (!result.ok) return; // lost the race; whoever won will drive it forward

		const nextStage = stageOrder[newIndex] ?? null;
		if (!nextStage) {
			emitToRoom(code, { kind: 'StageChanged', stage: null });
			await resolveNight(code);
			return;
		}
		if (nextStage.kind === 'ROLE_TURN' && !(await roleHasLivingHolder(code, nextStage.role))) {
			index = newIndex;
			continue;
		}

		emitToRoom(code, { kind: 'StageChanged', stage: nextStage });
		if (nextStage.kind === 'ROLE_TURN') await notifyRoleHolders(code, nextStage.role, nightNumber);
		return;
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Small pacing beat after a player's night action, before the next role gets
// prompted (or the night resolves) - gives the group a moment to notice the
// turn actually changed, rather than the next prompt appearing instantly. In
// practice this also gives the host device's narration line for the role
// that just acted time to finish speaking before the next one is queued,
// since acting always takes longer than the ~1-2s these lines take to speak.
const POST_ACTION_PAUSE_MS = 3000;

/** Not awaited by callers - the pause is pacing for the *next* prompt, not
 * part of the submitting player's own acknowledgment, so it must not extend
 * how long their `NightSubmitAction` ack takes to come back. */
async function tryAutoAdvance(code: string, room: RoomHashData): Promise<void> {
	const stage = currentStageOf(room);
	if (!stage) return;
	if (stage.kind === 'COUPLE_REVEAL') return; // informational, host-advanced only
	if (stage.role === '猎人') return; // no action to wait for, host-advanced only

	const hasActed = await redis.hexists(nightActionsKey(code, room.nightNumber), stage.role);
	if (!hasActed) return;

	await sleep(POST_ACTION_PAUSE_MS);
	await advanceWithinNight(code, room.stageIndex, room.stageOrder, room.nightNumber);
}

function scheduleAutoAdvance(code: string, room: RoomHashData): void {
	tryAutoAdvance(code, room).catch((err) => console.error('tryAutoAdvance failed', err));
}

async function gatherNightActionInputs(
	code: string,
	night: number,
	identities: Record<string, Role>
): Promise<NightActionInputs> {
	const raw = await redis.hgetall(nightActionsKey(code, night));
	const actions: Partial<Record<string, NightActionSubmission>> = {};
	for (const [role, json] of Object.entries(raw)) {
		actions[role] = JSON.parse(json);
	}

	const wolfAction = actions['普通狼人'];
	const witchAction = actions['女巫'];
	const guardAction = actions['守卫'];
	const wolfBeautyAction = actions['狼美人'];

	const werewolfKillSeat = wolfAction?.role === '普通狼人' ? wolfAction.targetSeat : null;
	const witchAntidoteSeat =
		witchAction?.role === '女巫' && witchAction.useAntidote ? werewolfKillSeat : null;

	const wolfBeautySeatEntry = Object.entries(identities).find(([, r]) => r === '狼美人');
	const coupleSeats = await getCoupleSeats(code);

	return {
		werewolfKillSeat,
		witchPoisonSeat: witchAction?.role === '女巫' ? witchAction.poisonTarget : null,
		witchAntidoteSeat,
		guardProtectSeat: guardAction?.role === '守卫' ? guardAction.targetSeat : null,
		wolfBeautyTargetSeat: wolfBeautyAction?.role === '狼美人' ? wolfBeautyAction.targetSeat : null,
		wolfBeautySeat: wolfBeautySeatEntry ? Number(wolfBeautySeatEntry[0]) : null,
		coupleSeats
	};
}

// ---------------------------------------------------------------------------
// Public state-machine entry points, called by socket handlers
// ---------------------------------------------------------------------------

export async function startNight1(code: string): Promise<void> {
	const room = await readRoomHash(code);
	if (!room) return;
	const order = buildNight1Order(room.roleConfig);

	await redis.hset(roomKey(code), {
		phase: 'NIGHT_ACTIONS',
		nightNumber: '1',
		lockStatus: '1',
		// Per-game role state starts fresh here - this is the one point every
		// path into a new game passes through.
		witchUsedAntidote: '0',
		witchUsedPoison: '0',
		guardLastSeat: ''
	});
	await touchRoomTtl(code);
	emitToRoom(code, { kind: 'PhaseChanged', phase: 'NIGHT_ACTIONS', nightNumber: 1 });
	emitToRoom(code, { kind: 'LockUpdated', locked: true });

	await enterStageOrder(code, order, 1);
}

export async function submitNightAction(
	code: string,
	actingSeat: number,
	action: NightActionSubmission
): Promise<{ ok: true } | { ok: false; error: NightRuleError }> {
	const room = await readRoomHash(code);
	if (!room) return { ok: true };

	const nightKey = nightActionsKey(code, room.nightNumber);

	// Rule checks run BEFORE anything is persisted. The client already greys
	// out illegal choices, but that's only UX - a hand-rolled socket frame can
	// send anything, so the rules are enforced here.
	if (action.role === '女巫' || action.role === '守卫') {
		// Both now have effects that outlive the night (a spent potion, the
		// guard's remembered target), so a resubmit would burn state whose
		// action then gets overwritten. Deliberately NOT applied to 普通狼人,
		// which shares one field across all wolves.
		if (await redis.hexists(nightKey, action.role)) {
			return { ok: false, error: 'already_submitted' };
		}
	}

	if (action.role === '女巫') {
		// Re-read the kill from Redis rather than trusting the copy the client
		// was handed in its TurnContext.
		const wolfActionRaw = await redis.hget(nightKey, '普通狼人');
		const wolfAction = wolfActionRaw ? (JSON.parse(wolfActionRaw) as NightActionSubmission) : null;
		const error = validateWitchAction(
			{ useAntidote: action.useAntidote, poisonTarget: action.poisonTarget },
			{
				witchSeat: actingSeat,
				killedSeat: wolfAction?.role === '普通狼人' ? wolfAction.targetSeat : null,
				usedAntidote: room.witchUsedAntidote,
				usedPoison: room.witchUsedPoison
			}
		);
		if (error) return { ok: false, error };
	}

	if (action.role === '守卫') {
		const error = validateGuardAction(action.targetSeat, room.guardLastSeat);
		if (error) return { ok: false, error };
	}

	await redis.hset(nightKey, action.role, JSON.stringify(action));
	await redis.expire(nightKey, ROOM_TTL_SECONDS);

	// Cross-night state, recorded only once the action is accepted.
	if (action.role === '女巫') {
		const spent: Record<string, string> = {};
		if (action.useAntidote) spent.witchUsedAntidote = '1';
		if (action.poisonTarget !== null) spent.witchUsedPoison = '1';
		if (Object.keys(spent).length > 0) await redis.hset(roomKey(code), spent);
	}
	if (action.role === '守卫') {
		await redis.hset(roomKey(code), { guardLastSeat: String(action.targetSeat) });
	}

	emitToRoom(code, { kind: 'NightActionAck', role: action.role });

	if (action.role === '预言家') {
		const identities = await getIdentities(code);
		const targetRole = identities[String(action.targetSeat)];
		if (targetRole) {
			const seerSession = await findSessionInSeat(code, actingSeat);
			if (seerSession) {
				emitToSession(seerSession, {
					kind: 'SeerResult',
					targetSeat: action.targetSeat,
					isWolf: roleTeam(targetRole) === 'wolf'
				});
			}
		}
	}

	if (action.role === '丘比特') {
		await redis.del(coupleSeatsKey(code));
		await redis.sadd(coupleSeatsKey(code), String(action.seatA), String(action.seatB));
		await redis.expire(coupleSeatsKey(code), ROOM_TTL_SECONDS);
		const [sessA, sessB] = await Promise.all([
			findSessionInSeat(code, action.seatA),
			findSessionInSeat(code, action.seatB)
		]);
		if (sessA) emitToSession(sessA, { kind: 'CoupleRevealed', partnerSeat: action.seatB });
		if (sessB) emitToSession(sessB, { kind: 'CoupleRevealed', partnerSeat: action.seatA });
	}

	if (action.role === '盗贼' && action.swap) {
		const identities = await getIdentities(code);
		const newRole = identities[action.swap];
		if (newRole) {
			await redis.hset(identitiesKey(code), String(actingSeat), newRole);
			const thiefSession = await findSessionInSeat(code, actingSeat);
			if (thiefSession) emitToSession(thiefSession, { kind: 'YourRole', role: newRole });
		}
	}

	scheduleAutoAdvance(code, room);
	return { ok: true };
}

export async function hostAdvanceStage(code: string): Promise<void> {
	const room = await readRoomHash(code);
	if (!room) return;
	await advanceWithinNight(code, room.stageIndex, room.stageOrder, room.nightNumber);
}

export async function resolveNight(code: string): Promise<void> {
	const room = await readRoomHash(code);
	if (!room) return;
	const identities = await getIdentities(code);
	const inputs = await gatherNightActionInputs(code, room.nightNumber, identities);
	const deaths = resolveNightDeaths(inputs);

	if (deaths.length > 0) {
		await redis.sadd(deadSeatsKey(code), ...deaths.map(String));
	}
	// Dead seats are already marked above - voting/etc. is never blocked on
	// this - but the actual "who died" reveal is held back until the host
	// broadcasts it (NightAnnounceResults), so the narration can play in the
	// right order (天亮 first, then the death announcement) and the host can
	// choose the moment without it gating anything else.
	await redis.hset(roomKey(code), { pendingNightDeaths: JSON.stringify(deaths) });
	await touchRoomTtl(code, room.nightNumber);
	emitToRoom(code, { kind: 'NightAnnouncePending' });

	const canShoot = hunterCanShoot(
		identities,
		inputs.witchPoisonSeat,
		inputs.coupleSeats,
		room.cupidPoisonBlocksHunter
	);
	const hunterDeath = deaths.find((s) => identities[String(s)] === '猎人');
	if (hunterDeath !== undefined && !canShoot) {
		const poisonedHunter = await findSessionInSeat(code, hunterDeath);
		if (poisonedHunter) emitToSession(poisonedHunter, { kind: 'HunterDenied', reason: 'poison' });
	}
	if (hunterDeath !== undefined && canShoot) {
		await redis.hset(roomKey(code), {
			phase: 'NIGHT_HUNTER_SHOT',
			hunterShotSeat: String(hunterDeath),
			hunterShotResolved: '0',
			phaseAfterHunterShot: 'DAY_VOTE'
		});
		await touchRoomTtl(code);
		emitToRoom(code, {
			kind: 'PhaseChanged',
			phase: 'NIGHT_HUNTER_SHOT',
			nightNumber: room.nightNumber
		});
		emitToRoom(code, { kind: 'HunterPending', hunterSeat: hunterDeath });
		const shooter = await findSessionInSeat(code, hunterDeath);
		if (shooter) emitToSession(shooter, { kind: 'HunterAuthorized' });
		return;
	}

	if (await checkWinAndMaybeEnd(code, identities)) return;

	await redis.hset(roomKey(code), { phase: 'DAY_VOTE' });
	await redis.del(votesKey(code));
	await touchRoomTtl(code);
	emitToRoom(code, { kind: 'PhaseChanged', phase: 'DAY_VOTE', nightNumber: room.nightNumber });
}

export async function advanceToNextNight(code: string): Promise<void> {
	const room = await readRoomHash(code);
	if (!room) return;
	const identities = await getIdentities(code);
	const [seatsMap, deadSeats] = await Promise.all([getSeats(code), getDeadSeats(code)]);
	const deadSet = new Set(deadSeats);
	const seatedSeatNumbers = Object.keys(seatsMap)
		.filter((s) => seatsMap[s])
		.map(Number);
	const living = livingRolesFrom(identities, seatedSeatNumbers, deadSet);
	const nextOrder = buildRepeatingOrder(living);
	const nextNight = room.nightNumber + 1;

	await redis.hset(roomKey(code), { phase: 'NIGHT_ACTIONS', nightNumber: String(nextNight) });
	await touchRoomTtl(code);
	emitToRoom(code, { kind: 'PhaseChanged', phase: 'NIGHT_ACTIONS', nightNumber: nextNight });

	await enterStageOrder(code, nextOrder, nextNight);
}

export async function castVote(
	code: string,
	voterSeat: number,
	target: number | 'abstain'
): Promise<void> {
	const deadSeats = await getDeadSeats(code);
	if (deadSeats.includes(voterSeat)) return;

	await redis.hset(votesKey(code), String(voterSeat), String(target));
	await redis.expire(votesKey(code), ROOM_TTL_SECONDS);
	const votes = await getVotes(code);
	emitToRoom(code, { kind: 'VoteUpdated', votes });
}

export async function tallyVotes(code: string): Promise<void> {
	const room = await readRoomHash(code);
	if (!room) return;
	const [votes, identities] = await Promise.all([getVotes(code), getIdentities(code)]);

	const tally = new Map<number, number>();
	for (const target of Object.values(votes)) {
		if (target === 'abstain') continue;
		tally.set(target, (tally.get(target) ?? 0) + 1);
	}

	let eliminated: number | null = null;
	let tie = false;
	if (tally.size > 0) {
		const max = Math.max(...tally.values());
		const leaders = Array.from(tally.entries())
			.filter(([, count]) => count === max)
			.map(([seat]) => seat);
		if (leaders.length === 1) eliminated = leaders[0];
		else tie = true;
	}

	let identity: Role | null = null;
	if (eliminated !== null) {
		await redis.sadd(deadSeatsKey(code), String(eliminated));
		identity = identities[String(eliminated)] ?? null;
	}
	await touchRoomTtl(code);
	emitToRoom(code, { kind: 'DayResolved', eliminatedSeat: eliminated, identity, tie });

	if (eliminated !== null && identity === '猎人') {
		await redis.hset(roomKey(code), {
			phase: 'DAY_HUNTER_SHOT',
			hunterShotSeat: String(eliminated),
			hunterShotResolved: '0',
			phaseAfterHunterShot: 'NEXT_NIGHT'
		});
		await touchRoomTtl(code);
		emitToRoom(code, {
			kind: 'PhaseChanged',
			phase: 'DAY_HUNTER_SHOT',
			nightNumber: room.nightNumber
		});
		emitToRoom(code, { kind: 'HunterPending', hunterSeat: eliminated });
		const shooter = await findSessionInSeat(code, eliminated);
		if (shooter) emitToSession(shooter, { kind: 'HunterAuthorized' });
		return;
	}

	if (await checkWinAndMaybeEnd(code, identities)) return;

	await advanceToNextNight(code);
}

export async function resolveHunterShot(code: string, target: number | null): Promise<void> {
	const room = await readRoomHash(code);
	if (!room || !room.hunterShotSeat) return;
	const hunterSeat = Number(room.hunterShotSeat);

	if (target !== null) {
		await redis.sadd(deadSeatsKey(code), String(target));
	}
	await touchRoomTtl(code);
	emitToRoom(code, { kind: 'HunterResolved', hunterSeat, shotSeat: target });

	const identities = await getIdentities(code);
	if (await checkWinAndMaybeEnd(code, identities)) return;

	if (room.phaseAfterHunterShot === 'DAY_VOTE') {
		await redis.hset(roomKey(code), { phase: 'DAY_VOTE' });
		await redis.del(votesKey(code));
		await touchRoomTtl(code);
		emitToRoom(code, { kind: 'PhaseChanged', phase: 'DAY_VOTE', nightNumber: room.nightNumber });
	} else {
		await advanceToNextNight(code);
	}
}
