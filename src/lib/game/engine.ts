// The pure reducer at the heart of the M0 rewrite (附录A#1: no IO, no clock
// reads, no imports from Svelte/Socket.IO/Redis). `reduce(state, action)`
// plus `startGame(params)` are the only two entry points M1's IO shell will
// ever call. The reducers behind them live in ./reducers/ (night, day,
// daySpecials, hostOverride, core) - private implementation detail, never
// imported from outside src/lib/game.
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
import type {
	EngineAction,
	EngineResult,
	GameState,
	RuleConfig,
	Seat,
	Setup,
	Player
} from './types';
import type { DealResult } from './rules/deal';
import { withEffects } from './reducers/core';
import {
	handleNextSpeaker,
	handleBeginVote,
	handleEndDay,
	handleSkipVote,
	handleCastVote,
	handleExile,
	handleDayOut,
	handleTallyVotes
} from './reducers/day';
import { handleHunterShoot, handleSelfExplode, handleKnightDuel } from './reducers/daySpecials';
import { handleHostOverride } from './reducers/hostOverride';
import {
	computeStageOrder,
	nextStageAfter,
	enterStage,
	handleAnnounceNightResults,
	handleSubmitNightAction,
	handleAdvanceStage,
	handleConfirmStage
} from './reducers/night';

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export interface StartGameParams {
	roomCode: string;
	ruleConfig: RuleConfig;
	setup: Setup;
	deal: DealResult;
	players: Array<{ seat: Seat; sessionId: string; nickname: string }>;
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
		startedAt: params.now,
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
		dayDecided: false,
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
	return tellConvertedChild(apply(state, action));
}

/** A 野孩子 whose idol died is a wolf from that moment, but learns it only
 * once the death is public - a night death stays secret until 公布, and the
 * news of their own change would give it away. Checked after every action,
 * so whichever one makes the death public is the one that tells them. */
function tellConvertedChild(result: EngineResult): EngineResult {
	const { wildChildSeat: seat, wildChildIdol: idol, pendingNightDeaths } = result.state;
	const child = seat === null ? undefined : result.state.players[seat];
	if (seat === null || !child || !child.convertedToWolf || child.conversionTold) return result;
	// Switch off: only the camp changed, and nobody is told.
	if (!result.state.ruleConfig.wildChild?.joinsPack) return result;
	if ((pendingNightDeaths ?? []).some((d) => d.seat === idol)) return result;
	const told = withEffects(result.state, (draft, effects) => {
		draft.players[seat].conversionTold = true;
		effects.push({ kind: 'PRIVATE', seat, payload: { kind: 'YourRole', role: 'WEREWOLF' } });
		effects.push({ kind: 'PRIVATE', seat, payload: { kind: 'WildChildConverted' } });
	});
	return { state: told.state, effects: [...result.effects, ...told.effects] };
}

function apply(state: GameState, action: EngineAction): EngineResult {
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
		case 'END_DAY':
			return handleEndDay(state);
		case 'SKIP_VOTE':
			return handleSkipVote(state);
		case 'DAY_OUT':
			return handleDayOut(state, action);
		case 'CONFIRM_STAGE':
			return handleConfirmStage(state, action);
		case 'EXILE':
			return handleExile(state, action);
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
