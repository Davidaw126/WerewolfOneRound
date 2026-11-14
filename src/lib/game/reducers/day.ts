// The day: last words, discussion, the vote and PK re-vote, exile and the
// Host's record of who left, and entering the hunter's shot. Part of the
// engine (see engine.ts) - pure, no IO.

import type {
	DayResultRecord,
	Death,
	EngineAction,
	EngineEffect,
	EngineResult,
	GameState,
	Seat
} from '../types';
import { cascadeDeaths } from '../rules/nightResolution';
import { checkWinCondition } from '../rules/winCondition';
import { STATUS_STAGE_ROLES } from '../roleMeta';
import { withEffects, endGame } from './core';
import { advanceToNextNight } from './night';

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
/** Tells the table the day's outcome, and keeps it for a phone that reloads
 * after the moment. */
function announceDayResult(
	draft: GameState,
	effects: EngineEffect[],
	result: DayResultRecord
): void {
	draft.announcedDayResult = { ...result };
	effects.push({ kind: 'BROADCAST', payload: { kind: 'DayResolved', ...result } });
}

export function enterHunterShootOrContinue(
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
export function lastWordsFrom(deaths: Death[], allowed: boolean): Seat[] {
	return allowed ? deaths.map((d) => d.seat).sort((a, b) => a - b) : [];
}

// ---------------------------------------------------------------------------
// NEXT_SPEAKER / BEGIN_VOTE - host-driven day-phase queue advancement (M5).
// ---------------------------------------------------------------------------

export function handleNextSpeaker(state: GameState): EngineResult {
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

export function handleBeginVote(state: GameState): EngineResult {
	return withEffects(state, (draft, effects) => {
		if (draft.phase !== 'DISCUSSION' || draft.dayDecided) return;
		// The table flow votes by hand unless the room turned the phone vote
		// on (the legacy in-app shot flow always had it).
		if (draft.ruleConfig.shotsAtTable && !draft.ruleConfig.inAppVote) return;
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

export function handleEndDay(state: GameState): EngineResult {
	return withEffects(state, (draft, effects) => {
		if (draft.phase !== 'DISCUSSION' && draft.phase !== 'VOTE' && draft.phase !== 'VOTE_PK') return;
		// Any votes cast so far are void - nobody is exiled today.
		draft.votes = {};
		draft.pkCandidates = [];
		draft.currentSpeaker = null;
		enterHunterShootOrContinue(draft, effects, [], 'NIGHT');
	});
}

export function handleCastVote(
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

/** The exile itself, shared by TALLY_VOTES and the host's EXILE.
 * §9.5 / B16-B19: a not-yet-revealed IDIOT flips their card instead of
 * dying - no death cascade at all (not even a T1 lover-suicide check,
 * matching the spec's "不进入死亡结算" exactly), loses their vote (default),
 * keeps their seat and speech right. Everyone else dies of VOTE_OUT, with
 * the usual cascade (殉情, a queued hunter/wolf-king shot). */
function applyExile(
	draft: GameState,
	seat: Seat
): { idiotRevealed: boolean; exiledDeaths: Death[]; followDeathSeat: Seat | null } {
	const cfg = draft.ruleConfig;
	const player = draft.players[seat];
	if (player && player.role === 'IDIOT' && !player.isRevealedIdiot && cfg.idiot.revealOnExile) {
		player.isRevealedIdiot = true;
		player.revealedRole = 'IDIOT';
		if (cfg.idiot.losesVoteRight) player.hasVoteRight = false;
		// Sheriff-badge handling (B18: tearsBadgeIfSheriff) deferred - no
		// sheriff mechanic exists yet for a revealed idiot to hold a badge.
		return { idiotRevealed: true, exiledDeaths: [], followDeathSeat: null };
	}
	const exiledDeaths = cascadeDeaths(draft, [{ seat, cause: 'VOTE_OUT' }], {
		ruleConfig: cfg
	});
	const followDeathSeat = exiledDeaths.find((d) => d.seat !== seat)?.seat ?? null;
	return { idiotRevealed: false, exiledDeaths, followDeathSeat };
}

export function handleExile(
	state: GameState,
	action: Extract<EngineAction, { type: 'EXILE' }>
): EngineResult {
	return withEffects(state, (draft, effects) => {
		if (draft.phase !== 'DISCUSSION' || draft.dayDecided) return;
		const target = draft.players[action.seat];
		// A flipped 白痴 can't be exiled again to any effect (B19).
		if (!target || target.isDead || target.isRevealedIdiot) return;

		draft.dayDecided = true;
		const { idiotRevealed, exiledDeaths, followDeathSeat } = applyExile(draft, action.seat);
		announceDayResult(draft, effects, {
			eliminatedSeat: action.seat,
			// Not revealed: an exiled player's card stays face down (only
			// the 白痴's flip is public, via idiotRevealed).
			identity: null,
			tie: false,
			followDeathSeat,
			followDeathIdentity: null,
			idiotRevealed
		});
		effects.push({ kind: 'BROADCAST', payload: { kind: 'DayDecided' } });
		const lastWordsSeats = lastWordsFrom(exiledDeaths, draft.ruleConfig.lastWords.exiledPlayer);
		// Back to DISCUSSION (not NIGHT) once any shot resolves - the host
		// starts the night with 进入下一夜.
		enterHunterShootOrContinue(draft, effects, lastWordsSeats, 'DISCUSSION');
	});
}

/** Privately tells every fallen 猎人/狼王/黑狼王 whether this death lets
 * them shoot - read off pendingShoots, which cascadeDeaths just filled via
 * canTriggerShoot. Only the app knows some causes (a 狼美人 link, a poisoned
 * lover), so the shooter can't always work it out at the table. */
export function pushShotStatus(draft: GameState, effects: EngineEffect[], deaths: Death[]): void {
	for (const d of deaths) {
		const role = draft.players[d.seat]?.role;
		if (!role || !(STATUS_STAGE_ROLES.has(role) || role === 'WOLF_KING')) continue;
		const canShoot = draft.pendingShoots.includes(d.seat);
		draft.shotStatuses = { ...draft.shotStatuses, [d.seat]: canShoot };
		effects.push({ kind: 'PRIVATE', seat: d.seat, payload: { kind: 'ShotStatus', canShoot } });
	}
}

/** The host records who left the table today - exiled, self-exploded or shot,
 * all of which the table already saw happen. The app only adds what the
 * table can't see: a lover's 殉情. A flipped 白痴 is simply not marked.
 * Never queues a shot (a shooter among them fires at the table too) and
 * never leaves DISCUSSION - the host may mark more, then 进入下一夜. */
export function handleDayOut(
	state: GameState,
	action: Extract<EngineAction, { type: 'DAY_OUT' }>
): EngineResult {
	return withEffects(state, (draft, effects) => {
		if (draft.phase !== 'DISCUSSION') return;
		const seats = [...new Set(action.seats)]
			.filter((seat) => draft.players[seat] && !draft.players[seat].isDead)
			.sort((a, b) => a - b);
		if (seats.length === 0) return;

		const deaths = cascadeDeaths(
			draft,
			seats.map((seat) => ({ seat, cause: 'DAY_OUT' as const })),
			{ ruleConfig: draft.ruleConfig }
		);
		// A marked seat knows how they left (and so whether they may shoot);
		// one dragged along by the cascade may not.
		const follow = deaths.filter((d) => !seats.includes(d.seat));
		pushShotStatus(draft, effects, follow);
		draft.pendingShoots = [];
		const followDeaths = follow.map((d) => d.seat).sort((a, b) => a - b);
		effects.push({ kind: 'BROADCAST', payload: { kind: 'DayOut', seats, followDeaths } });

		const winner = checkWinCondition(draft);
		if (winner) endGame(draft, effects, winner);
	});
}

export function handleTallyVotes(
	state: GameState,
	action: Extract<EngineAction, { type: 'TALLY_VOTES' }>
): EngineResult {
	return withEffects(state, (draft, effects) => {
		if (draft.phase !== 'VOTE' && draft.phase !== 'VOTE_PK') return;
		const cfg = draft.ruleConfig;
		const inPk = draft.phase === 'VOTE_PK';
		// The table flow's phone vote: like the Host's EXILE, the result
		// returns to the Host's day console, settled - shots happen at the
		// table. (Without inAppVote this is the legacy in-app flow.)
		const atTable = cfg.inAppVote && cfg.shotsAtTable;

		// Ballots are public once the vote closes; each seat's picks are kept
		// for 潜行者 tonight.
		const votes: Record<Seat, Seat | 'ABSTAIN'> = { ...draft.votes };
		const dayVotes = { ...draft.dayVotes };
		for (const [seat, target] of Object.entries(votes)) {
			if (target !== 'ABSTAIN')
				dayVotes[Number(seat)] = [...(dayVotes[Number(seat)] ?? []), target];
		}
		draft.dayVotes = dayVotes;

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
					announceDayResult(draft, effects, {
						eliminatedSeat: null,
						identity: null,
						tie: true,
						followDeathSeat: null,
						followDeathIdentity: null,
						idiotRevealed: false,
						pkCandidates: [...leaders],
						votes
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

		let followDeathSeat: Seat | null = null;
		let idiotRevealed = false;
		let exiledDeaths: Death[] = [];
		if (eliminated !== null) {
			({ idiotRevealed, exiledDeaths, followDeathSeat } = applyExile(draft, eliminated));
		}
		announceDayResult(draft, effects, {
			eliminatedSeat: eliminated,
			// Cards stay face down on exile (same as EXILE) - only the
			// 白痴's flip is public, via idiotRevealed.
			identity: null,
			tie,
			followDeathSeat,
			followDeathIdentity: null,
			idiotRevealed,
			votes
		});

		if (atTable) {
			draft.votes = {};
			draft.pkCandidates = [];
			draft.dayDecided = true;
			pushShotStatus(draft, effects, exiledDeaths);
			draft.pendingShoots = [];
			effects.push({ kind: 'BROADCAST', payload: { kind: 'DayDecided' } });
			const lastWordsSeats = lastWordsFrom(exiledDeaths, cfg.lastWords.exiledPlayer);
			enterHunterShootOrContinue(draft, effects, lastWordsSeats, 'DISCUSSION');
			return;
		}

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
