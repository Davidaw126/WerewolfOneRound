// The night: stage order and sequencing, night actions, 确认 stages, and
// resolving the night into DAWN until the Host announces it. Part of the
// engine (see engine.ts) - pure, no IO.

import type {
	Death,
	EngineAction,
	EngineEffect,
	EngineResult,
	GameState,
	RoleId,
	Seat
} from '../types';
import { stageKey, currentStage, currentStageRole, roleHasLivingHolder } from '../rules/stage';
import {
	buildNight1Order,
	buildRepeatingOrder,
	livingRolesFrom,
	ALWAYS_ANNOUNCED_ROLES,
	type NightStage
} from '../rules/nightOrder';
import { notifyRoleHolders } from '../rules/turnContext';
import { resolveNight, cascadeDeaths, type NightResolutionContext } from '../rules/nightResolution';
import {
	validateWitchAction,
	validateGuardAction,
	validateSeerAction,
	validateWolfKillAction
} from '../rules/nightRules';
import { baseCamp } from '../rules/winCondition';
import {
	ROLE_META,
	PACK_KILL_ROLES,
	PACK_MEMBER_ROLES,
	STATUS_STAGE_ROLES,
	actsInStage
} from '../roleMeta';
import { withEffects, reject } from './core';
import { enterHunterShootOrContinue, lastWordsFrom, pushShotStatus } from './day';

// ---------------------------------------------------------------------------
// Night stage sequencing - recomputed fresh from GameState every call (see
// file header). `currentStepKey` is the only piece of "where are we"
// actually persisted on GameState.
// ---------------------------------------------------------------------------

export function computeStageOrder(state: GameState): NightStage[] {
	if (state.isFirstNight) return buildNight1Order(state.setup.roleConfig);

	const identities: Record<string, RoleId> = {};
	const seatedSeatNumbers: number[] = [];
	const deadSeats = new Set<Seat>();
	for (const p of Object.values(state.players)) {
		seatedSeatNumbers.push(p.seat);
		identities[String(p.seat)] = p.role;
		if (p.isDead) deadSeats.add(p.seat);
	}
	const living = livingRolesFrom(identities, seatedSeatNumbers, deadSeats);
	return buildRepeatingOrder(living, state.setup.roleConfig);
}

/** Finds the next stage after `fromKey` (null = before the first stage),
 * skipping any ROLE_TURN with no living holder - EXCEPT the §8.5 假环节 set
 * (ALWAYS_ANNOUNCED_ROLES), which is never skipped even with zero living
 * holders: skipping them is exactly the timing/sequence leak 假环节 exists to
 * close (see nightOrder.ts's comment on that set). Null return means the
 * order is exhausted and the night should resolve. */
export function nextStageAfter(
	state: GameState,
	order: NightStage[],
	fromKey: string | null
): NightStage | null {
	const fromIndex = fromKey === null ? -1 : order.findIndex((s) => stageKey(s) === fromKey);
	for (let i = fromIndex + 1; i < order.length; i++) {
		const stage = order[i];
		if (
			stage.kind === 'ROLE_TURN' &&
			!ALWAYS_ANNOUNCED_ROLES.has(stage.role) &&
			!roleHasLivingHolder(state, stage.role)
		) {
			continue;
		}
		return stage;
	}
	return null;
}

/** Enters `stage` (or, if null, resolves the night) - the single place a
 * stage transition's effects get built, shared by ADVANCE_STAGE and every
 * internal caller that lands on a fresh stage order (startGame,
 * advanceToNextNight). */
export function enterStage(
	draft: GameState,
	effects: EngineEffect[],
	stage: NightStage | null
): void {
	if (!stage) {
		draft.currentStepKey = null;
		effects.push({ kind: 'BROADCAST', payload: { kind: 'StageChanged', stage: null } });
		resolveNightPhase(draft, effects);
		return;
	}
	draft.currentStepKey = stageKey(stage);
	draft.stageConfirms = [];
	effects.push({ kind: 'BROADCAST', payload: { kind: 'StageChanged', stage } });
	if (stage.kind === 'ROLE_TURN') {
		effects.push(...notifyRoleHolders(draft, stage.role));
	}
}

/** Bumps into a fresh night (round+1), resetting the per-night scratch
 * fields, and enters its first stage - shared by startGame (round 1) and
 * every "night resolved uneventfully, go again" path. */
export function advanceToNextNight(draft: GameState, effects: EngineEffect[]): void {
	draft.round += 1;
	draft.isFirstNight = false;
	draft.phase = 'NIGHT';
	draft.nightActions = {};
	draft.submittedRoles = [];
	draft.charmedSeat = null;
	draft.fearedSeat = null;
	draft.currentStepKey = null;
	draft.dayDecided = false;
	effects.push({
		kind: 'BROADCAST',
		payload: { kind: 'PhaseChanged', phase: 'NIGHT', nightNumber: draft.round }
	});

	const order = computeStageOrder(draft);
	enterStage(draft, effects, nextStageAfter(draft, order, null));
}

// ---------------------------------------------------------------------------
// §10 Night resolution. Resolves into phase DAWN carrying the (possibly
// empty - a peaceful night still needs "announcing") death list, gated
// behind an explicit ANNOUNCE_NIGHT_RESULTS action rather than the spec's
// automatic-on-DAWN announcement - decision 7 (M0 plan): this app keeps its
// deliberate host-taps-「公布夜晚结果」step. Unlike the old app (which folded
// straight through to DAY_VOTE/hunter-shoot in the same call, and used the
// announce tap purely as a client-side narration cue with no effect on
// server phase), DAWN is now a real gating phase: the hunter-shoot/win-check/
// VOTE transition below only happens once ANNOUNCE_NIGHT_RESULTS fires. This
// is not a user-visible change - the client already withheld the death
// reveal from players until that same tap - it just makes the state machine
// honest about what the tap actually gates.
// ---------------------------------------------------------------------------

export function resolveNightPhase(draft: GameState, effects: EngineEffect[]): void {
	const ctx: NightResolutionContext = { lastDreamTarget: draft.lastDreamTarget };
	const pending = resolveNight(draft.ruleConfig, ctx, draft.nightActions);
	const resolved = cascadeDeaths(draft, pending, { ruleConfig: draft.ruleConfig });

	// This night's dream target becomes "last night's" for the NEXT night's
	// two-nights-running check (§10.2 Step 3) - must be updated after
	// resolveNight reads the OLD value via ctx above, not before.
	draft.lastDreamTarget = draft.nightActions.dreamWeaverTarget ?? null;

	draft.pendingNightDeaths = resolved;
	draft.phase = 'DAWN';
	draft.currentStepKey = null;
	effects.push({
		kind: 'BROADCAST',
		payload: { kind: 'PhaseChanged', phase: 'DAWN', nightNumber: draft.round }
	});
	effects.push({ kind: 'BROADCAST', payload: { kind: 'NightAnnouncePending' } });
}

export function handleAnnounceNightResults(state: GameState): EngineResult {
	return withEffects(state, (draft, effects) => {
		if (draft.phase !== 'DAWN' || draft.pendingNightDeaths === null) return; // not our turn / already announced

		// Reconstructed into plain objects, not a spread - see the GameOver
		// comment above on why a draft-derived array of OBJECTS (each Death a
		// nested proxy) can't be handed to `effects` as-is.
		const deaths: Death[] = draft.pendingNightDeaths.map((d) => ({ seat: d.seat, cause: d.cause }));
		effects.push({
			kind: 'BROADCAST',
			payload: { kind: 'NightResultsAnnounced', deaths, nightNumber: draft.round }
		});
		draft.pendingNightDeaths = null;

		// A hunter who died tonight but isn't in pendingShoots was denied a shot
		// by cascadeDeaths' own canTriggerShoot filter (T5) - under today's
		// default RuleConfig the only reachable denial is witch poison, so
		// 'poison' matches the old app's literal reason string; a house rule
		// that denies e.g. canShootWhenWolfKilled would also land here without
		// actually being a poison denial. SPEC-GAP: no distinct reason per cause.
		if (draft.ruleConfig.shotsAtTable) {
			// The shot happens at the table and the host records its victim
			// with DAY_OUT - just tell each fallen shooter whether they may.
			pushShotStatus(draft, effects, deaths);
			draft.pendingShoots = [];
		}
		for (const d of draft.ruleConfig.shotsAtTable ? [] : deaths) {
			const player = draft.players[d.seat];
			// 黑狼王 too: poison is likewise his only reachable night denial.
			if (player && STATUS_STAGE_ROLES.has(player.role) && !draft.pendingShoots.includes(d.seat)) {
				effects.push({
					kind: 'PRIVATE',
					seat: d.seat,
					payload: { kind: 'HunterDenied', reason: 'poison' }
				});
			}
		}

		const lastWordsSeats = lastWordsFrom(
			deaths,
			draft.isFirstNight
				? draft.ruleConfig.lastWords.firstNightVictim
				: draft.ruleConfig.lastWords.nightVictimAfterFirst
		);
		enterHunterShootOrContinue(draft, effects, lastWordsSeats, 'DISCUSSION');
	});
}

// ---------------------------------------------------------------------------
// SUBMIT_NIGHT_ACTION - per-role submission handling. Ownership (does `seat`
// actually hold `role`?) is validated by the IO shell before this ever runs
// (M1, matching today's handlers/night.ts) - the switch below is the RULE
// layer, not the auth layer, same split as the old app's
// stateMachine.ts/nightRules.ts.
// ---------------------------------------------------------------------------

export function handleSubmitNightAction(
	state: GameState,
	action: Extract<EngineAction, { type: 'SUBMIT_NIGHT_ACTION' }>
): EngineResult {
	return withEffects(state, (draft, effects) => {
		const { seat, action: a } = action;
		const cfg = draft.ruleConfig;

		// Which turn this is decides what the submission means, not just the
		// submitter's card: a 狼美人 in the pack's WEREWOLF stage is choosing
		// the kill, in her own stage she's charming. Status stages (猎人 /
		// 黑狼王 确认开枪状态) take no submission at all - without this a 黑狼王
		// on his status stage could still make a pack kill.
		const stepKey = draft.currentStepKey;
		const inPackStage =
			stepKey === stageKey({ kind: 'ROLE_TURN', role: 'WEREWOLF' }) &&
			PACK_MEMBER_ROLES.has(action.role);
		const inOwnStage =
			stepKey === stageKey({ kind: 'ROLE_TURN', role: action.role }) &&
			!STATUS_STAGE_ROLES.has(action.role);
		if (!inPackStage && !inOwnStage) return reject(effects, seat, 'not_your_turn');
		const role: RoleId = inPackStage ? 'WEREWOLF' : action.role;
		const alreadySubmitted = draft.submittedRoles.includes(role);

		// §4.2/B49: a seat 恶灵骑士 feared earlier THIS SAME night (NIGHTMARE's
		// own order, 28, is before every role below it) can't use their own
		// skill for the rest of tonight - fearedSeat only clears at the start
		// of the next night (advanceToNextNight), so this also naturally
		// covers "no voting tomorrow" being a day-phase-only concern (see
		// handleCastVote's own identical guard).
		if (draft.fearedSeat === seat && action.role !== 'NIGHTMARE') {
			// Any real choice is blocked - but a feared player must still be able
			// to PASS, or nobody can end this turn: only COUPLE_REVEAL/HUNTER are
			// host-advanced, so a rejected-only turn froze the whole night.
			const isPass = Object.keys(a).length === 0;
			if (!isPass) return reject(effects, seat, 'feared');
			// The wolf kill is shared: a feared wolf passing must not use up the
			// pack's kill while an unfeared wolf can still make it.
			if (inPackStage) {
				const otherWolfCanAct = Object.values(draft.players).some(
					(p) =>
						!p.isDead &&
						p.seat !== seat &&
						p.seat !== draft.fearedSeat &&
						PACK_MEMBER_ROLES.has(p.role)
				);
				if (otherWolfCanAct) return reject(effects, seat, 'feared');
			} else {
				// Same for a 上帝之手 duplicate of any other role: the pass is
				// just this seat sitting the turn out, not the turn itself.
				const otherHolderCanAct = Object.values(draft.players).some(
					(p) =>
						!p.isDead && p.seat !== seat && p.seat !== draft.fearedSeat && p.role === action.role
				);
				if (otherHolderCanAct) return;
			}
			if (!draft.submittedRoles.includes(role)) draft.submittedRoles.push(role);
			effects.push({ kind: 'BROADCAST', payload: { kind: 'NightActionAck', role } });
			return;
		}

		// One action per role per night. The pack's shared kill has its own
		// check below; without this one a double-tapped (or raced) submit gave a
		// 预言家 two checks in one night.
		if (!inPackStage && alreadySubmitted) return reject(effects, seat, 'already_submitted');

		// Every seat named must be a living player. The client only offers
		// living seats, but its list can go stale mid-turn (上帝之手 kills
		// someone while the prompt is open) and the wire schema doesn't know
		// the board. The antidote's 0 is a presence marker, not a seat.
		const targets = [
			a.wolfKillTarget,
			a.seerCheckTarget,
			a.witchPoisonTarget,
			a.guardTarget,
			a.wolfBeautyCharmTarget,
			a.wildChildIdol,
			a.dreamWeaverTarget,
			a.nightmareFearTarget,
			...(a.cupidLinks ?? [])
		].filter((t): t is Seat => typeof t === 'number');
		if (targets.some((t) => !draft.players[t] || draft.players[t].isDead))
			return reject(effects, seat, 'invalid_target');
		if (a.cupidLinks && a.cupidLinks[0] === a.cupidLinks[1])
			return reject(effects, seat, 'invalid_target');

		switch (role) {
			case 'WEREWOLF':
			case 'WOLF_KING':
			case 'BLACK_WOLF_KING': {
				// WOLF_KING shares this same collective kill decision - no
				// separate night stage or nightActions field of its own (see
				// roleMeta.ts's WOLF_KING.nightOrder comment). Every wolf-team
				// seat holding either role gets its own YourTurnPrompt (see
				// turnContext.ts's notifyRoleHolders) - "first submission wins":
				// once any ONE of them has submitted tonight's kill, every other
				// wolf's later submission must be rejected outright, not silently
				// overwrite the first choice. Checked against BOTH role strings
				// (not just this submitter's own `role`/the generic
				// `alreadySubmitted` above), since a WEREWOLF submitting first
				// must also block a WOLF_KING's later submission and vice versa.
				if (draft.submittedRoles.some((r) => PACK_KILL_ROLES.has(r))) {
					return reject(effects, seat, 'already_submitted');
				}
				const target = a.wolfKillTarget ?? null;
				const error = validateWolfKillAction(cfg, target);
				if (error) return reject(effects, seat, error);
				draft.nightActions.wolfKillTarget = target;
				// The rest of the pack is still awake looking at their prompt -
				// tell them a teammate settled it, so they can close their eyes.
				for (const p of Object.values(draft.players)) {
					if (p.seat === seat || p.isDead || !actsInStage('WEREWOLF', p.role)) continue;
					effects.push({
						kind: 'PRIVATE',
						seat: p.seat,
						payload: { kind: 'PackKillChosen', bySeat: seat, target }
					});
				}
				break;
			}
			case 'WITCH': {
				if (alreadySubmitted) return reject(effects, seat, 'already_submitted');
				const useAntidote = a.witchAntidoteTarget !== undefined;
				const poisonTarget = a.witchPoisonTarget ?? null;
				const killedSeat = draft.nightActions.wolfKillTarget ?? null;
				const error = validateWitchAction(
					cfg,
					{ useAntidote, poisonTarget },
					{
						witchSeat: seat,
						killedSeat,
						usedAntidote: draft.witchAntidoteUsed,
						usedPoison: draft.witchPoisonUsed,
						isFirstNight: draft.isFirstNight
					}
				);
				if (error) return reject(effects, seat, error);
				if (useAntidote && killedSeat !== null) {
					draft.nightActions.witchAntidoteTarget = killedSeat;
					draft.witchAntidoteUsed = true;
				}
				if (poisonTarget !== null) {
					draft.nightActions.witchPoisonTarget = poisonTarget;
					draft.witchPoisonUsed = true;
				}
				break;
			}
			case 'GUARD': {
				if (alreadySubmitted) return reject(effects, seat, 'already_submitted');
				const target = a.guardTarget;
				if (target === undefined) return;
				const error = validateGuardAction(cfg, target, seat, draft.lastGuardTarget);
				if (error) return reject(effects, seat, error);
				draft.nightActions.guardTarget = target;
				draft.lastGuardTarget = target;
				break;
			}
			case 'SEER': {
				const target = a.seerCheckTarget;
				if (target === undefined) return;
				const error = validateSeerAction(cfg, target, seat);
				if (error) return reject(effects, seat, error);
				draft.nightActions.seerCheckTarget = target;
				const targetPlayer = draft.players[target];
				if (targetPlayer) {
					// Deliberately baseCamp, not getCamp: matches the old app's
					// roleTeam(targetRole) exactly, which never accounted for
					// cross-camp-lovers third-party status either (CUPID's night
					// slot runs before SEER's, so a just-linked couple's dynamic
					// LOVERS camp is already computable here - this is a conscious
					// parity choice, not an oversight). SPEC-GAP: spec doesn't say
					// what a seer should see for a 情侣 target.
					const isBad = baseCamp(targetPlayer) === 'WEREWOLF';
					effects.push({
						kind: 'PRIVATE',
						seat,
						payload: { kind: 'SeerResult', targetSeat: target, isBad }
					});
				}
				break;
			}
			case 'CUPID': {
				const links = a.cupidLinks;
				if (!links) return;
				draft.lovers = links;
				draft.cupidSeat = seat;
				const [seatA, seatB] = links;
				effects.push({
					kind: 'PRIVATE',
					seat: seatA,
					payload: { kind: 'CoupleRevealed', partnerSeat: seatB }
				});
				effects.push({
					kind: 'PRIVATE',
					seat: seatB,
					payload: { kind: 'CoupleRevealed', partnerSeat: seatA }
				});
				break;
			}
			case 'THIEF': {
				const pick = a.thiefPick ?? null;
				const player = draft.players[seat];
				const cards = player?.thiefExtraCards ?? [];
				// UT-24 双狼牌强制选狼: "keep original identity" isn't a valid
				// choice when both buried cards are wolf-team roles - only a
				// SINGLE wolf card among the two still leaves a real choice.
				const bothWolf = cards.length === 2 && cards.every((c) => ROLE_META[c].camp === 'WEREWOLF');
				if (bothWolf && cfg.thief.mustTakeWolfIfBothWolf && pick === null) {
					return reject(effects, seat, 'thief_must_take_wolf');
				}
				if (pick !== null && player && cards.includes(pick)) {
					player.role = pick;
					effects.push({ kind: 'PRIVATE', seat, payload: { kind: 'YourRole', role: pick } });
				}
				break;
			}
			case 'WOLF_BEAUTY': {
				const target = a.wolfBeautyCharmTarget;
				if (target === undefined) return;
				draft.nightActions.wolfBeautyCharmTarget = target;
				draft.charmedSeat = target;
				break;
			}
			case 'WILD_CHILD': {
				// firstNightOnly (roleMeta.ts) - nightOrder.ts never builds this
				// stage past night 1, so no `alreadySubmitted` guard is needed the
				// way GUARD/WITCH need one across repeated nights.
				const idol = a.wildChildIdol;
				if (idol === undefined) return;
				if (idol === seat) return reject(effects, seat, 'invalid_target');
				draft.nightActions.wildChildIdol = idol;
				// Persistent identity link (not just tonight's nightActions) - T3 in
				// nightResolution.ts's cascadeDeaths reads these every night from
				// here on to decide whether the idol's death converts this seat.
				draft.wildChildSeat = seat;
				draft.wildChildIdol = idol;
				break;
			}
			case 'DREAM_WEAVER': {
				const target = a.dreamWeaverTarget;
				if (target === undefined) return;
				draft.nightActions.dreamWeaverTarget = target;
				break;
			}
			case 'NIGHTMARE': {
				const target = a.nightmareFearTarget;
				if (target === undefined) return;
				draft.nightActions.nightmareFearTarget = target;
				// Persistent (not nightActions-scoped): stays in effect through
				// tonight's remaining turns and tomorrow's vote, cleared only by
				// advanceToNextNight - see the fearedSeat guard above this switch
				// and handleCastVote's identical one.
				draft.fearedSeat = target;
				break;
			}
			case 'HUNTER':
				// HUNTER_STATUS is an informational ping (§4.2) - no decision to
				// submit, only host-advanced. Matches the old app's tryAutoAdvance
				// special-case for 猎人.
				return;
			default:
				// IDIOT/KNIGHT/WOLF_KING aren't `implemented` yet (see
				// roleMeta.ts) - nightOrder.ts never builds
				// them a turn to reach here, so this is unreachable in M0/M1.
				return;
		}

		if (!draft.submittedRoles.includes(role)) draft.submittedRoles.push(role);
		effects.push({ kind: 'BROADCAST', payload: { kind: 'NightActionAck', role } });
		// Every role but the pack's is one per board - unless 上帝之手 handed
		// out a second copy. Then the other holder, still looking at the
		// prompt, is told the turn is already taken (the pack's own version,
		// with the target, is PackKillChosen above).
		if (!inPackStage) {
			for (const p of Object.values(draft.players)) {
				if (p.seat === seat || p.isDead || !actsInStage(role, p.role)) continue;
				effects.push({ kind: 'PRIVATE', seat: p.seat, payload: { kind: 'RoleDoneByOther' } });
			}
		}
	});
}

// ---------------------------------------------------------------------------
// ADVANCE_STAGE - host-triggered (or IO-shell-timer-triggered, after the
// same POST_ACTION_PAUSE_MS pacing beat the old app used) step forward.
// ---------------------------------------------------------------------------

export function handleAdvanceStage(
	state: GameState,
	action: Extract<EngineAction, { type: 'ADVANCE_STAGE' }>
): EngineResult {
	return withEffects(state, (draft, effects) => {
		if (draft.phase !== 'FIRST_NIGHT' && draft.phase !== 'NIGHT') return;
		if (action.expectedStepKey !== undefined && action.expectedStepKey !== draft.currentStepKey) {
			return; // stale delayed auto-advance - someone else already moved on
		}
		const order = computeStageOrder(draft);
		enterStage(draft, effects, nextStageAfter(draft, order, draft.currentStepKey));
	});
}

// ---------------------------------------------------------------------------
// CAST_VOTE / TALLY_VOTES
// ---------------------------------------------------------------------------

/** The stages where everyone else has their eyes shut, so the host can't
 * see when to move on: the 猎人/黑狼王 checking their 开枪状态, and the
 * couple recognising each other. The player(s) themselves tap 确认; once
 * the stage is complete (stageConfirmComplete) the IO shell advances it
 * after the same pause as any other finished turn.
 * Anyone else's tap is a no-op (every phone shows the same button during
 * 情侣相认, so the button itself can't give the couple away). */
export function handleConfirmStage(
	state: GameState,
	action: Extract<EngineAction, { type: 'CONFIRM_STAGE' }>
): EngineResult {
	return withEffects(state, (draft, effects) => {
		if (draft.phase !== 'FIRST_NIGHT' && draft.phase !== 'NIGHT') return;
		const key = draft.currentStepKey;
		const player = draft.players[action.seat];
		if (!key || !player || player.isDead) return;
		const stage = currentStage(draft);
		if (stage?.kind === 'COUPLE_REVEAL') {
			const lovers = (draft.lovers ?? []).filter((s) => !draft.players[s]?.isDead);
			const confirms = draft.stageConfirms ?? [];
			if (!lovers.includes(action.seat) || confirms.includes(action.seat)) return;
			draft.stageConfirms = [...confirms, action.seat];
			effects.push({ kind: 'PRIVATE', seat: action.seat, payload: { kind: 'StageConfirmed' } });
			return;
		}

		const role = currentStageRole(draft);
		if (!role || !STATUS_STAGE_ROLES.has(role) || !actsInStage(role, player.role)) return;
		if ((draft.stageConfirms ?? []).includes(action.seat)) return;
		draft.stageConfirms = [...(draft.stageConfirms ?? []), action.seat];
		effects.push({ kind: 'PRIVATE', seat: action.seat, payload: { kind: 'StageConfirmed' } });
	});
}
