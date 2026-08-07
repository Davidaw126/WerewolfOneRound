// The pure reducer at the heart of the M0 rewrite (附录A#1: no IO, no clock
// reads, no imports from Svelte/Socket.IO/Redis). `reduce(state, action)`
// plus `startGame(params)` are the only two entry points M1's IO shell will
// ever call - everything else here is a private implementation detail.
//
// Time deliberately never gets read in this file (no `Date.now()`,
// `setTimeout`, etc.) - the old app's POST_ACTION_PAUSE_MS auto-advance and
// any per-step deadline are the IO shell's job (M1): it schedules a delayed
// `ADVANCE_STAGE`/`TALLY_VOTES` action itself and calls back into `reduce`,
// exactly the same way a host's manual tap does. That's also why the old
// `stageEpoch`/`stageOrder`/`stageIndex` CAS machinery has no equivalent
// here: M1 puts a per-room lock around every load -> reduce -> save, so two
// calls into this reducer for the same room can never race each other, and
// `computeStageOrder` recomputes the night's step order fresh from current
// GameState on every call instead of trusting a possibly-stale stored copy.
//
// Ported from src/lib/server/game/stateMachine.ts + turnContext.ts +
// hunterShot.ts, ADR-style: every place this reducer's behavior deliberately
// differs from that file is called out inline as it comes up, not just
// listed once here.

import { produce } from 'immer';
import type {
	Death,
	DeathCause,
	EngineAction,
	EngineEffect,
	EngineResult,
	GameState,
	RoleId,
	RuleConfig,
	Seat,
	Setup,
	Player,
	Camp
} from './types';
import type { DealResult } from './rules/deal';
import {
	buildNight1Order,
	buildRepeatingOrder,
	livingRolesFrom,
	ALWAYS_ANNOUNCED_ROLES,
	type NightStage
} from './rules/nightOrder';
import { notifyRoleHolders } from './rules/turnContext';
import { resolveNight, cascadeDeaths, type NightResolutionContext } from './rules/nightResolution';
import {
	validateWitchAction,
	validateGuardAction,
	validateSeerAction,
	validateWolfKillAction,
	type NightRuleError
} from './rules/nightRules';
import { checkWinCondition, baseCamp } from './rules/winCondition';
import { ROLE_META } from './roleMeta';

// ---------------------------------------------------------------------------
// withEffects - the immer + side-channel-effects-array pattern every handler
// below is built on. Effects are plain descriptions (§2.1.2), never actual
// socket emits - only the IO shell turns them into real I/O.
// ---------------------------------------------------------------------------

function withEffects(
	state: GameState,
	recipe: (draft: GameState, effects: EngineEffect[]) => void
): EngineResult {
	const effects: EngineEffect[] = [];
	const newState = produce(state, (draft) => {
		recipe(draft as GameState, effects);
	});
	return { state: newState, effects };
}

function reject(effects: EngineEffect[], seat: Seat, error: NightRuleError): void {
	effects.push({ kind: 'PRIVATE', seat, payload: { kind: 'NightActionRejected', error } });
}

// ---------------------------------------------------------------------------
// Night stage sequencing - recomputed fresh from GameState every call (see
// file header). `currentStepKey` is the only piece of "where are we"
// actually persisted on GameState.
// ---------------------------------------------------------------------------

function stageKey(stage: NightStage): string {
	return stage.kind === 'ROLE_TURN' ? `role:${stage.role}` : 'couple_reveal';
}

function computeStageOrder(state: GameState): NightStage[] {
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

function roleHasLivingHolder(state: GameState, role: RoleId): boolean {
	return Object.values(state.players).some((p) => !p.isDead && p.role === role);
}

/** Finds the next stage after `fromKey` (null = before the first stage),
 * skipping any ROLE_TURN with no living holder - EXCEPT the §8.5 假环节 set
 * (ALWAYS_ANNOUNCED_ROLES), which is never skipped even with zero living
 * holders: skipping them is exactly the timing/sequence leak 假环节 exists to
 * close (see nightOrder.ts's comment on that set). Null return means the
 * order is exhausted and the night should resolve. */
function nextStageAfter(
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
function enterStage(draft: GameState, effects: EngineEffect[], stage: NightStage | null): void {
	if (!stage) {
		draft.currentStepKey = null;
		effects.push({ kind: 'BROADCAST', payload: { kind: 'StageChanged', stage: null } });
		resolveNightPhase(draft, effects);
		return;
	}
	draft.currentStepKey = stageKey(stage);
	effects.push({ kind: 'BROADCAST', payload: { kind: 'StageChanged', stage } });
	if (stage.kind === 'ROLE_TURN') {
		effects.push(...notifyRoleHolders(draft, stage.role));
	}
}

/** Bumps into a fresh night (round+1), resetting the per-night scratch
 * fields, and enters its first stage - shared by startGame (round 1) and
 * every "night resolved uneventfully, go again" path. */
function advanceToNextNight(draft: GameState, effects: EngineEffect[]): void {
	draft.round += 1;
	draft.isFirstNight = false;
	draft.phase = 'NIGHT';
	draft.nightActions = {};
	draft.submittedRoles = [];
	draft.charmedSeat = null;
	draft.fearedSeat = null;
	draft.currentStepKey = null;
	effects.push({
		kind: 'BROADCAST',
		payload: { kind: 'PhaseChanged', phase: 'NIGHT', nightNumber: draft.round }
	});

	const order = computeStageOrder(draft);
	enterStage(draft, effects, nextStageAfter(draft, order, null));
}

function endGame(draft: GameState, effects: EngineEffect[], winner: Camp): void {
	draft.phase = 'GAME_OVER';
	draft.winner = winner;
	const identities: Record<Seat, RoleId> = {};
	for (const p of Object.values(draft.players)) identities[p.seat] = p.role;
	// Immer revokes every draft proxy once produce() returns - `effects` lives
	// outside the draft tree, so any array/object read off `draft` must be
	// copied into a plain value before it's embedded in a payload, or it
	// becomes a "revoked proxy" the instant this producer call finishes. A
	// shallow spread is enough here since the tuple only ever holds primitive
	// seat numbers.
	const coupleSeats: [Seat, Seat] | null = draft.lovers ? [draft.lovers[0], draft.lovers[1]] : null;
	effects.push({
		kind: 'BROADCAST',
		payload: { kind: 'GameOver', winner, identities, coupleSeats }
	});
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

function resolveNightPhase(draft: GameState, effects: EngineEffect[]): void {
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

function handleAnnounceNightResults(state: GameState): EngineResult {
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
		for (const d of deaths) {
			const player = draft.players[d.seat];
			if (player?.role === 'HUNTER' && !draft.pendingShoots.includes(d.seat)) {
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

/** Shared tail for every place that might have just produced deaths needing
 * last words and/or queued a hunter/wolf-king shot (night resolution,
 * day-vote tally, self-explode, knight duel, and HUNTER_SHOOT's own
 * chain-shot resolution) - §7.2's LAST_WORDS -> HUNTER_SHOOT -> {DISCUSSION,
 * NIGHT} chain, plus §7.3's "every phase change MUST check the winner first".
 * Those two rules interact: a pending hunter shot can still change the
 * outcome (killing a wolf-king's shot target, say), so checking win-condition
 * while one is queued risks a wrong/premature call - matching the pre-M5
 * precedent, the check is skipped whenever pendingShoots is non-empty and
 * deferred to whichever later call (after the shot resolves) has an empty
 * queue. LAST_WORDS itself never changes who's alive, so it doesn't get the
 * same deferral - a winner found before it starts skips it entirely (a
 * decided game has no need for closing remarks). */
function enterHunterShootOrContinue(
	draft: GameState,
	effects: EngineEffect[],
	lastWordsSeats: Seat[],
	whenDone: 'DISCUSSION' | 'NIGHT'
): void {
	if (draft.pendingShoots.length === 0) {
		const winner = checkWinCondition(draft);
		if (winner) {
			endGame(draft, effects, winner);
			return;
		}
	}

	if (lastWordsSeats.length > 0) {
		draft.phase = 'LAST_WORDS';
		draft.pendingLastWords = lastWordsSeats;
		draft.currentSpeaker = lastWordsSeats[0];
		draft.returnPhase = whenDone;
		effects.push({
			kind: 'BROADCAST',
			payload: { kind: 'PhaseChanged', phase: 'LAST_WORDS', nightNumber: draft.round }
		});
		effects.push({
			kind: 'BROADCAST',
			payload: { kind: 'LastWordsSpeakerChanged', seat: draft.currentSpeaker }
		});
		return;
	}

	if (draft.pendingShoots.length > 0) {
		draft.phase = 'HUNTER_SHOOT';
		draft.returnPhase = whenDone;
		const hunterSeat = draft.pendingShoots[0];
		effects.push({ kind: 'BROADCAST', payload: { kind: 'HunterPending', hunterSeat } });
		effects.push({ kind: 'PRIVATE', seat: hunterSeat, payload: { kind: 'HunterAuthorized' } });
		return;
	}

	const winner = checkWinCondition(draft);
	if (winner) {
		endGame(draft, effects, winner);
		return;
	}

	if (whenDone === 'DISCUSSION') {
		enterDiscussion(draft, effects);
	} else {
		advanceToNextNight(draft, effects);
	}
}

/** §9.3 DISCUSSION - speech order is living seats in ascending seat-number
 * order for now (SPEC-GAP: the sheriff-direction choice - "从警长左边/右边开
 * 始" - is task #37/M5's SHERIFF_ELECTION, not yet built). Not a hard gate on
 * voting: BEGIN_VOTE can fire at any point regardless of where the queue is. */
function enterDiscussion(draft: GameState, effects: EngineEffect[]): void {
	draft.phase = 'DISCUSSION';
	const order = Object.values(draft.players)
		.filter((p) => !p.isDead)
		.map((p) => p.seat)
		.sort((a, b) => a - b);
	draft.speechOrder = order;
	draft.currentSpeaker = order[0] ?? null;
	effects.push({
		kind: 'BROADCAST',
		payload: { kind: 'PhaseChanged', phase: 'DISCUSSION', nightNumber: draft.round }
	});
	effects.push({
		kind: 'BROADCAST',
		payload: { kind: 'DiscussionSpeakerChanged', seat: draft.currentSpeaker, order }
	});
}

/** Filters a fresh cascadeDeaths() result down to the seats that get last
 * words, per whichever single RuleConfig switch governs THIS batch of deaths
 * (the caller already knows which one applies) - seat-ascending per B42. */
function lastWordsFrom(deaths: Death[], allowed: boolean): Seat[] {
	return allowed ? deaths.map((d) => d.seat).sort((a, b) => a - b) : [];
}

// ---------------------------------------------------------------------------
// NEXT_SPEAKER / BEGIN_VOTE - host-driven day-phase queue advancement (M5).
// ---------------------------------------------------------------------------

function handleNextSpeaker(state: GameState): EngineResult {
	return withEffects(state, (draft, effects) => {
		if (draft.phase === 'LAST_WORDS') {
			draft.pendingLastWords.shift();
			if (draft.pendingLastWords.length > 0) {
				draft.currentSpeaker = draft.pendingLastWords[0];
				effects.push({
					kind: 'BROADCAST',
					payload: { kind: 'LastWordsSpeakerChanged', seat: draft.currentSpeaker }
				});
				return;
			}
			draft.currentSpeaker = null;
			const whenDone = draft.returnPhase === 'NIGHT' ? 'NIGHT' : 'DISCUSSION';
			draft.returnPhase = null;
			enterHunterShootOrContinue(draft, effects, [], whenDone);
			return;
		}

		if (draft.phase === 'DISCUSSION') {
			const idx =
				draft.currentSpeaker !== null ? draft.speechOrder.indexOf(draft.currentSpeaker) : -1;
			const next = draft.speechOrder[idx + 1] ?? null;
			draft.currentSpeaker = next;
			effects.push({
				kind: 'BROADCAST',
				payload: { kind: 'DiscussionSpeakerChanged', seat: next, order: [...draft.speechOrder] }
			});
		}
	});
}

function handleBeginVote(state: GameState): EngineResult {
	return withEffects(state, (draft, effects) => {
		if (draft.phase !== 'DISCUSSION') return;
		draft.phase = 'VOTE';
		draft.votes = {};
		draft.pkCandidates = [];
		draft.currentSpeaker = null;
		effects.push({
			kind: 'BROADCAST',
			payload: { kind: 'PhaseChanged', phase: 'VOTE', nightNumber: draft.round }
		});
	});
}

// ---------------------------------------------------------------------------
// SUBMIT_NIGHT_ACTION - per-role submission handling. Ownership (does `seat`
// actually hold `role`?) is validated by the IO shell before this ever runs
// (M1, matching today's handlers/night.ts) - the switch below is the RULE
// layer, not the auth layer, same split as the old app's
// stateMachine.ts/nightRules.ts.
// ---------------------------------------------------------------------------

function handleSubmitNightAction(
	state: GameState,
	action: Extract<EngineAction, { type: 'SUBMIT_NIGHT_ACTION' }>
): EngineResult {
	return withEffects(state, (draft, effects) => {
		const { seat, role, action: a } = action;
		const cfg = draft.ruleConfig;
		const alreadySubmitted = draft.submittedRoles.includes(role);

		// §4.2/B49: a seat 恶灵骑士 feared earlier THIS SAME night (NIGHTMARE's
		// own order, 28, is before every role below it) can't use their own
		// skill for the rest of tonight - fearedSeat only clears at the start
		// of the next night (advanceToNextNight), so this also naturally
		// covers "no voting tomorrow" being a day-phase-only concern (see
		// handleCastVote's own identical guard).
		if (draft.fearedSeat === seat && role !== 'NIGHTMARE') {
			return reject(effects, seat, 'feared');
		}

		switch (role) {
			case 'WEREWOLF':
			case 'WOLF_KING': {
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
				if (
					draft.submittedRoles.includes('WEREWOLF') ||
					draft.submittedRoles.includes('WOLF_KING')
				) {
					return reject(effects, seat, 'already_submitted');
				}
				const target = a.wolfKillTarget ?? null;
				const error = validateWolfKillAction(cfg, target);
				if (error) return reject(effects, seat, error);
				draft.nightActions.wolfKillTarget = target;
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
	});
}

// ---------------------------------------------------------------------------
// ADVANCE_STAGE - host-triggered (or IO-shell-timer-triggered, after the
// same POST_ACTION_PAUSE_MS pacing beat the old app used) step forward.
// ---------------------------------------------------------------------------

function handleAdvanceStage(
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

function handleCastVote(
	state: GameState,
	action: Extract<EngineAction, { type: 'CAST_VOTE' }>
): EngineResult {
	return withEffects(state, (draft, effects) => {
		if (draft.phase !== 'VOTE' && draft.phase !== 'VOTE_PK') return;
		const player = draft.players[action.seat];
		if (!player || player.isDead || !player.hasVoteRight) return;
		// §4.2/B49 - 恶灵骑士 feared this seat the preceding night; no vote until
		// fearedSeat clears at the start of the next night.
		if (draft.fearedSeat === action.seat) return;
		if (draft.phase === 'VOTE_PK') {
			// "平票者本人不可投票" + a PK round only ever decides between the tied
			// candidates - voting for anyone else wouldn't mean anything.
			if (draft.pkCandidates.includes(action.seat)) return;
			if (action.target !== 'ABSTAIN' && !draft.pkCandidates.includes(action.target)) return;
		}
		draft.votes[action.seat] = action.target;

		// S11: broadcast only WHO has voted and how many are eligible - never
		// the running tally or anyone's actual pick, so nobody's choice gets
		// influenced by watching others' land in real time. The full
		// breakdown only ever reaches players via DayResolved, after
		// TALLY_VOTES has already committed the outcome.
		const votedSeats = Object.keys(draft.votes).map(Number);
		const totalVoters = Object.values(draft.players).filter(
			(p) => !p.isDead && p.hasVoteRight
		).length;
		effects.push({
			kind: 'BROADCAST',
			payload: { kind: 'VoteUpdated', votedSeats, totalVoters }
		});
	});
}

function handleTallyVotes(
	state: GameState,
	action: Extract<EngineAction, { type: 'TALLY_VOTES' }>
): EngineResult {
	return withEffects(state, (draft, effects) => {
		if (draft.phase !== 'VOTE' && draft.phase !== 'VOTE_PK') return;
		const cfg = draft.ruleConfig;
		const inPk = draft.phase === 'VOTE_PK';

		const tally = new Map<Seat, number>();
		for (const target of Object.values(draft.votes)) {
			if (target === 'ABSTAIN') continue;
			tally.set(target, (tally.get(target) ?? 0) + 1);
		}
		let eliminated: Seat | null = null;
		let tie = false;
		if (tally.size > 0) {
			const max = Math.max(...tally.values());
			const leaders = Array.from(tally.entries())
				.filter(([, count]) => count === max)
				.map(([s]) => s)
				.sort((a, b) => a - b);
			if (leaders.length === 1) {
				eliminated = leaders[0];
			} else {
				tie = true;
				// §9.4 平票处理. A PK re-tie always ends the day with nobody exiled
				// ("仅一轮" - no second PK) regardless of tieBreak; a first-round tie
				// consults the switch.
				if (!inPk && cfg.tieBreak === 'PK_THEN_NO_EXILE') {
					draft.phase = 'VOTE_PK';
					draft.pkCandidates = leaders;
					draft.votes = {};
					effects.push({
						kind: 'BROADCAST',
						payload: {
							kind: 'DayResolved',
							eliminatedSeat: null,
							identity: null,
							tie: true,
							followDeathSeat: null,
							followDeathIdentity: null,
							idiotRevealed: false,
							pkCandidates: [...leaders]
						}
					});
					effects.push({
						kind: 'BROADCAST',
						payload: { kind: 'PhaseChanged', phase: 'VOTE_PK', nightNumber: draft.round }
					});
					return;
				}
				if (!inPk && cfg.tieBreak === 'RANDOM') {
					const idx = (((action.random ?? 0) % leaders.length) + leaders.length) % leaders.length;
					eliminated = leaders[idx];
					tie = false;
				}
				// 'NO_EXILE' (and a PK re-tie) fall through with eliminated staying
				// null - nobody's exiled this round.
			}
		}

		let identity: RoleId | null = null;
		let followDeathSeat: Seat | null = null;
		let followDeathIdentity: RoleId | null = null;
		let idiotRevealed = false;
		let exiledDeaths: Death[] = [];
		if (eliminated !== null) {
			const eliminatedPlayer = draft.players[eliminated];
			identity = eliminatedPlayer?.role ?? null;

			// §9.5 / B16-B19: an exiled, not-yet-revealed IDIOT flips their card
			// instead of dying - no death cascade at all (not even a T1
			// lover-suicide check, matching the spec's "不进入死亡结算" exactly),
			// loses their vote (default), keeps their seat and speech right, and
			// can be exiled again later with no further effect (B19 - already
			// true here for free, since isRevealedIdiot re-entering this branch
			// is excluded by the check below, falling through to a normal - but
			// by then impossible, since a dead-or-revealed idiot can't be voted
			// for meaningfully twice in the same way - VOTE_OUT death; a second
			// exile of an already-revealed idiot is a day-phase/UI concern for
			// M5, not reachable from TALLY_VOTES alone).
			if (
				eliminatedPlayer &&
				eliminatedPlayer.role === 'IDIOT' &&
				!eliminatedPlayer.isRevealedIdiot &&
				cfg.idiot.revealOnExile
			) {
				eliminatedPlayer.isRevealedIdiot = true;
				eliminatedPlayer.revealedRole = 'IDIOT';
				if (cfg.idiot.losesVoteRight) eliminatedPlayer.hasVoteRight = false;
				idiotRevealed = true;
				// Sheriff-badge handling (B18: tearsBadgeIfSheriff) deferred to
				// M5 - no sheriff mechanic exists yet for a revealed idiot to hold
				// a badge in the first place.
			} else {
				exiledDeaths = cascadeDeaths(draft, [{ seat: eliminated, cause: 'VOTE_OUT' }], {
					ruleConfig: draft.ruleConfig
				});
				const follow = exiledDeaths.find((d) => d.seat !== eliminated);
				if (follow) {
					followDeathSeat = follow.seat;
					followDeathIdentity = draft.players[follow.seat]?.role ?? null;
				}
			}
		}
		effects.push({
			kind: 'BROADCAST',
			payload: {
				kind: 'DayResolved',
				eliminatedSeat: eliminated,
				identity,
				tie,
				followDeathSeat,
				followDeathIdentity,
				// Not yet part of the old wire DayResolved event (no client UI
				// consumes it until M5's exile flow lands) - the M1 effect
				// translator already only forwards the fields the old event
				// shape declares, so this is harmlessly dropped there for now.
				idiotRevealed
			}
		});

		if (idiotRevealed) {
			// B16: "当天不再重投" - nobody died, so no hunter-shoot to check;
			// still worth a win-condition check for consistency with every
			// other state-changing path, even though a reveal alone can never
			// flip it.
			const winner = checkWinCondition(draft);
			if (winner) {
				endGame(draft, effects, winner);
				return;
			}
			advanceToNextNight(draft, effects);
			return;
		}

		const lastWordsSeats = lastWordsFrom(exiledDeaths, cfg.lastWords.exiledPlayer);
		enterHunterShootOrContinue(draft, effects, lastWordsSeats, 'NIGHT');
	});
}

// ---------------------------------------------------------------------------
// HUNTER_SHOOT - resolves whichever seat is at the head of pendingShoots
// (chain-shot: a second HUNTER_SHOOT while more remain in the queue prompts
// the next one instead of leaving the phase).
// ---------------------------------------------------------------------------

function handleHunterShoot(
	state: GameState,
	action: Extract<EngineAction, { type: 'HUNTER_SHOOT' }>
): EngineResult {
	return withEffects(state, (draft, effects) => {
		if (draft.phase !== 'HUNTER_SHOOT') return;
		if (draft.pendingShoots[0] !== action.shooterSeat) return; // not this seat's turn
		draft.pendingShoots.shift();

		let followDeathSeat: Seat | null = null;
		let shotDeaths: Death[] = [];
		if (action.targetSeat !== null) {
			const shooter = draft.players[action.shooterSeat];
			const cause: DeathCause = shooter?.role === 'WOLF_KING' ? 'WOLF_KING_SHOT' : 'HUNTER_SHOT';
			shotDeaths = cascadeDeaths(draft, [{ seat: action.targetSeat, cause }], {
				ruleConfig: draft.ruleConfig
			});
			followDeathSeat = shotDeaths.find((d) => d.seat !== action.targetSeat)?.seat ?? null;
		}
		effects.push({
			kind: 'BROADCAST',
			payload: {
				kind: 'HunterResolved',
				hunterSeat: action.shooterSeat,
				shotSeat: action.targetSeat,
				followDeathSeat
			}
		});

		const whenDone = draft.returnPhase === 'NIGHT' ? 'NIGHT' : 'DISCUSSION';
		draft.returnPhase = null;
		const lastWordsSeats = lastWordsFrom(shotDeaths, draft.ruleConfig.lastWords.hunterShotVictim);
		enterHunterShootOrContinue(draft, effects, lastWordsSeats, whenDone);
	});
}

// ---------------------------------------------------------------------------
// ANNOUNCE_NIGHT_RESULTS - see resolveNightPhase's doc comment above.
// ---------------------------------------------------------------------------
// (handler defined above, next to resolveNightPhase)

// ---------------------------------------------------------------------------
// SELF_EXPLODE / KNIGHT_DUEL - §9.6 (M3/M5). Both are host-initiated day
// events the spec places in DISCUSSION (§9.3), where the host's UI keeps
// [有玩家自爆]/[骑士决斗] buttons resident for the whole phase.
// ---------------------------------------------------------------------------

function handleSelfExplode(
	state: GameState,
	action: Extract<EngineAction, { type: 'SELF_EXPLODE' }>
): EngineResult {
	return withEffects(state, (draft, effects) => {
		if (draft.phase !== 'DISCUSSION') return;
		const player = draft.players[action.seat];
		if (!player || player.isDead) return;
		// "必须是狼阵营，服务端校验" - baseCamp, not getCamp: a cross-camp-couple
		// wolf's DYNAMIC camp is 'LOVERS' (getCamp's third-party override), but
		// they're still mechanically a wolf and must still be allowed to
		// explode as one (same reasoning as KNIGHT_DUEL's targetIsWolf check
		// below - B31 requires this exact case to still count as a wolf).
		// baseCamp still correctly reflects an already-converted 野孩子 (M7) as
		// WEREWOLF too, so that case isn't lost either.
		if (baseCamp(player) !== 'WEREWOLF') return;

		const deaths = cascadeDeaths(draft, [{ seat: action.seat, cause: 'SELF_EXPLODE' }], {
			ruleConfig: draft.ruleConfig
		});
		effects.push({ kind: 'BROADCAST', payload: { kind: 'SelfExploded', seat: action.seat } });

		const lastWordsSeats = lastWordsFrom(deaths, draft.ruleConfig.wolf.selfExplodeHasLastWords);
		// A non-default config where the day continues after an explosion still
		// goes through the shared tail (not just a bare winner check) - a
		// queued wolf-king shot from the cascade above now correctly gets its
		// own HUNTER_SHOOT detour here instead of silently waiting for
		// TALLY_VOTES to eventually notice it.
		enterHunterShootOrContinue(
			draft,
			effects,
			lastWordsSeats,
			draft.ruleConfig.wolf.selfExplodeEndsDay ? 'NIGHT' : 'DISCUSSION'
		);
	});
}

function handleKnightDuel(
	state: GameState,
	action: Extract<EngineAction, { type: 'KNIGHT_DUEL' }>
): EngineResult {
	return withEffects(state, (draft, effects) => {
		if (draft.phase !== 'DISCUSSION') return;
		if (draft.knightUsed) return; // knight.onceOnly - the spec's only configured value
		if (action.knightSeat === action.targetSeat) return; // canTargetSelf: false

		const knight = draft.players[action.knightSeat];
		const target = draft.players[action.targetSeat];
		if (!knight || knight.isDead || knight.role !== 'KNIGHT') return;
		if (!target || target.isDead) return;

		draft.knightUsed = true;
		// baseCamp, not getCamp - see SELF_EXPLODE's identical note above (B31).
		const targetIsWolf = baseCamp(target) === 'WEREWOLF';
		// "服务端翻开被决斗者身份" - the target's identity is always exposed by
		// the duel itself, win or lose for the knight.
		target.revealedRole = target.role;

		if (targetIsWolf) {
			cascadeDeaths(draft, [{ seat: action.targetSeat, cause: 'KNIGHT_DUEL' }], {
				ruleConfig: draft.ruleConfig
			});
			effects.push({
				kind: 'BROADCAST',
				payload: {
					kind: 'KnightDuelResolved',
					knightSeat: action.knightSeat,
					targetSeat: action.targetSeat,
					targetWasWolf: true
				}
			});
			if (draft.ruleConfig.knight.duelEndsDayIfWolf) {
				// SPEC-GAP: no lastWords.* switch covers KNIGHT_DUEL - the duel
				// already publicly reveals the target's identity, unlike every
				// other last-words-eligible death cause.
				enterHunterShootOrContinue(draft, effects, [], 'NIGHT');
				return;
			}
		} else {
			if (draft.ruleConfig.knight.knightDiesIfGood) {
				cascadeDeaths(draft, [{ seat: action.knightSeat, cause: 'KNIGHT_DUEL_FAIL' }], {
					ruleConfig: draft.ruleConfig
				});
			} else {
				// House rule: the knight survives a failed duel - still exposed,
				// same as the always-revealed target above.
				knight.revealedRole = 'KNIGHT';
			}
			effects.push({
				kind: 'BROADCAST',
				payload: {
					kind: 'KnightDuelResolved',
					knightSeat: action.knightSeat,
					targetSeat: action.targetSeat,
					targetWasWolf: false
				}
			});
			// "白天继续，进入投票" - stays in DISCUSSION, no phase transition (the
			// day continues normally toward an eventual BEGIN_VOTE, same as if
			// nothing had happened).
		}

		const winner = checkWinCondition(draft);
		if (winner) endGame(draft, effects, winner);
	});
}

// ---------------------------------------------------------------------------
// HOST_OVERRIDE - 上帝之手 (§10.5). Minimal M0 plumbing so the type/action
// exists end to end; the actual override UI panel is M6 work.
// ---------------------------------------------------------------------------

function handleHostOverride(
	state: GameState,
	action: Extract<EngineAction, { type: 'HOST_OVERRIDE' }>
): EngineResult {
	return withEffects(state, (draft, effects) => {
		const player = draft.players[action.seat];
		if (!player) return;
		draft.hostOverrideCount += 1;

		if (action.kind === 'KILL') {
			if (!player.isDead)
				cascadeDeaths(draft, [{ seat: action.seat, cause: 'HOST_OVERRIDE' }], {
					ruleConfig: draft.ruleConfig
				});
		} else if (action.kind === 'REVIVE') {
			player.isDead = false;
			player.deathCause = undefined;
			player.deathRound = undefined;
		} else if (action.kind === 'SET_ROLE' && action.role) {
			player.role = action.role;
		}

		effects.push({
			kind: 'BROADCAST',
			payload: { kind: 'HostOverrideApplied', seat: action.seat, overrideKind: action.kind }
		});

		const winner = checkWinCondition(draft);
		if (winner) endGame(draft, effects, winner);
	});
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export interface StartGameParams {
	roomCode: string;
	ruleConfig: RuleConfig;
	setup: Setup;
	deal: DealResult;
	players: Array<{ seat: Seat; sessionId: string; nickname: string; isHost: boolean }>;
	now: number;
}

/** Builds the initial GameState for a freshly dealt game and enters night
 * 1's first stage. Room/seat/session lifecycle (who's in the lobby, seat
 * assignment) is a RoomManager concern per the spec's own architecture split
 * - this only ever runs once seats + a deal already exist. */
export function startGame(params: StartGameParams): EngineResult {
	const players: Record<Seat, Player> = {};
	for (const p of params.players) {
		const role = params.deal.identities[String(p.seat)];
		const player: Player = {
			seat: p.seat,
			sessionId: p.sessionId,
			nickname: p.nickname,
			isHost: p.isHost,
			connected: true,
			lastSeenAt: params.now,
			role,
			convertedToWolf: false,
			isDead: false,
			isRevealedIdiot: false,
			hasVoteRight: true,
			hasViewedIdentity: false
		};
		if (role === 'THIEF' && params.deal.buried) player.thiefExtraCards = [...params.deal.buried];
		players[p.seat] = player;
	}

	const initial: GameState = {
		roomCode: params.roomCode,
		phase: 'FIRST_NIGHT',
		round: 1,
		isFirstNight: true,
		ruleConfig: params.ruleConfig,
		setup: params.setup,
		players,
		currentStepKey: null,
		stepDeadline: null,
		nightActions: {},
		submittedRoles: [],
		lastGuardTarget: null,
		lastDreamTarget: null,
		charmedSeat: null,
		fearedSeat: null,
		lovers: null,
		cupidSeat: null,
		wildChildSeat: null,
		wildChildIdol: null,
		sheriffSeat: null,
		badgeTorn: false,
		speechOrder: [],
		currentSpeaker: null,
		votes: {},
		pkCandidates: [],
		pendingShoots: [],
		pendingLastWords: [],
		pendingBadgeTransfer: null,
		returnPhase: null,
		pendingNightDeaths: null,
		witchAntidoteUsed: false,
		witchPoisonUsed: false,
		knightUsed: false,
		hostOverrideCount: 0,
		timeline: [],
		winner: null
	};

	return withEffects(initial, (draft, effects) => {
		for (const p of Object.values(draft.players)) {
			effects.push({ kind: 'PRIVATE', seat: p.seat, payload: { kind: 'YourRole', role: p.role } });
		}
		effects.push({
			kind: 'BROADCAST',
			payload: { kind: 'PhaseChanged', phase: 'FIRST_NIGHT', nightNumber: 1 }
		});
		const order = computeStageOrder(draft);
		enterStage(draft, effects, nextStageAfter(draft, order, null));
	});
}

/** The engine's single steady-state entry point (§2.1.2). */
export function reduce(state: GameState, action: EngineAction): EngineResult {
	switch (action.type) {
		case 'SUBMIT_NIGHT_ACTION':
			return handleSubmitNightAction(state, action);
		case 'ADVANCE_STAGE':
			return handleAdvanceStage(state, action);
		case 'ANNOUNCE_NIGHT_RESULTS':
			return handleAnnounceNightResults(state);
		case 'NEXT_SPEAKER':
			return handleNextSpeaker(state);
		case 'BEGIN_VOTE':
			return handleBeginVote(state);
		case 'CAST_VOTE':
			return handleCastVote(state, action);
		case 'TALLY_VOTES':
			return handleTallyVotes(state, action);
		case 'HUNTER_SHOOT':
			return handleHunterShoot(state, action);
		case 'SELF_EXPLODE':
			return handleSelfExplode(state, action);
		case 'KNIGHT_DUEL':
			return handleKnightDuel(state, action);
		case 'HOST_OVERRIDE':
			return handleHostOverride(state, action);
	}
}
