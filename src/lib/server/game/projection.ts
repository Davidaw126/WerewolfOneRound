// Pure GameState -> old-wire-shape projections, shared by the effect
// translator (turns EngineEffects into socket emits) and the public-state
// view (StateSnapshot/ResyncRequest). Keeping both fed from the same
// functions is what guarantees they can never independently drift apart on
// what "the current phase" or "who's dead" means.
//
// This is the minimal, M1-scoped stand-in for what M4's viewFilter.ts will
// eventually become - it does NOT yet enforce per-viewer secrecy (that's
// still handled the same ad-hoc way it always was: PRIVATE effects only ever
// go to one session, and GAME_OVER is the only phase where full identities
// are exposed at all).

import type { Camp, GameState, RoleId } from '../../game/types';
import { currentStage } from '../../game/rules/stage';
import { revealedCard } from '../../game/rules/winCondition';
import type {
	NightStage as LegacyNightStage,
	PublicNightStage,
	Winner
} from '../../shared/gameTypes';

export function stageOf(state: GameState): LegacyNightStage | null {
	return currentStage(state);
}

/** S4: strips which role is acting - the room-wide broadcast form of
 * stageOf(). Callers that need the real role (host-only narration) use
 * stageOf() directly instead. */
export function toPublicStage(stage: LegacyNightStage | null): PublicNightStage | null {
	if (stage === null) return null;
	return stage.kind === 'ROLE_TURN' ? { kind: 'ROLE_TURN' } : stage;
}

/** Tonight's deaths are applied to `players[].isDead` the moment the night
 * resolves, but stay secret until the host taps 公布夜晚结果 - leaving them in
 * here let any phone that refreshed or reconnected at DAWN (an iPhone waking
 * from sleep does) read who died before the announcement. */
export function deadSeatsOf(state: GameState): number[] {
	const unannounced = new Set((state.pendingNightDeaths ?? []).map((d) => d.seat));
	return Object.values(state.players)
		.filter((p) => p.isDead && !unannounced.has(p.seat))
		.map((p) => p.seat)
		.sort((a, b) => a - b);
}

/** 白痴 who flipped on being voted out: alive, but without a vote. Public. */
export function revealedIdiotsOf(state: GameState): number[] {
	return Object.values(state.players)
		.filter((p) => p.isRevealedIdiot)
		.map((p) => p.seat)
		.sort((a, b) => a - b);
}

/** S11: WHO has voted, never who they voted for. */
export function votedSeatsOf(state: GameState): number[] {
	return Object.keys(state.votes).map(Number);
}

export function totalVotersOf(state: GameState): number {
	return Object.values(state.players).filter((p) => !p.isDead && p.hasVoteRight).length;
}

export function hunterSeatOf(state: GameState): number | null {
	return state.pendingShoots[0] ?? null;
}

/** M5 §9.1/9.3 - not itself sensitive (never reveals a role), unlike stage. */
export function currentSpeakerOf(state: GameState): number | null {
	return state.currentSpeaker;
}

export function speechOrderOf(state: GameState): number[] {
	return state.phase === 'DISCUSSION' ? [...state.speechOrder] : [];
}

export function pkCandidatesOf(state: GameState): number[] {
	return state.phase === 'VOTE_PK' ? [...state.pkCandidates] : [];
}

const WIRE_WINNER = { GOOD: 'villagers', WEREWOLF: 'wolves', LOVERS: 'lovers' } as const;

/** The engine's winning camp as the phones name it. */
export function toWireWinner(camp: Camp): Winner {
	return WIRE_WINNER[camp];
}

export function winnerOf(state: GameState): Winner | null {
	return state.winner ? toWireWinner(state.winner) : null;
}

export function identitiesOf(state: GameState): Record<number, RoleId> {
	const out: Record<number, RoleId> = {};
	for (const p of Object.values(state.players)) out[p.seat] = revealedCard(p);
	return out;
}
