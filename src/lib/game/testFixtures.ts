// Shared test-only builders for the M0 rule modules + engine.spec.ts. Not a
// *.spec.ts file itself - vitest only picks up files matching that pattern,
// so this plain module is safe to import from every spec under
// src/lib/game/ without adding a phantom "test suite" of its own.

import type { GameState, Player, RoleId, Seat, Setup } from './types';
import { buildSetup } from './rules/setup';
import { defaultRuleConfig } from './defaultRuleConfig';

export { defaultRuleConfig };

export function makePlayer(seat: Seat, role: RoleId, overrides: Partial<Player> = {}): Player {
	return {
		seat,
		sessionId: `session-${seat}`,
		nickname: `P${seat}`,
		isHost: false,
		connected: true,
		lastSeenAt: 0,
		role,
		convertedToWolf: false,
		isDead: false,
		isRevealedIdiot: false,
		hasVoteRight: true,
		hasViewedIdentity: false,
		...overrides
	};
}

/** Builds a full GameState from a seat->role map (every seat starts alive) -
 * `roles` also doubles as the deal composition Setup.godCount/villagerCount
 * are derived from, matching how a real game's setup reflects everyone ever
 * dealt in, not just who's currently alive. */
export function makeState(
	roles: Record<Seat, RoleId>,
	overrides: Partial<GameState> = {}
): GameState {
	const players: Record<Seat, Player> = {};
	const roleConfig: Partial<Record<RoleId, number>> = {};
	for (const [seatStr, role] of Object.entries(roles)) {
		const seat = Number(seatStr);
		players[seat] = makePlayer(seat, role);
		roleConfig[role] = (roleConfig[role] ?? 0) + 1;
	}
	const setup: Setup = buildSetup(roleConfig);

	return {
		roomCode: 'TEST',
		phase: 'NIGHT',
		round: 1,
		isFirstNight: false,
		ruleConfig: defaultRuleConfig(),
		setup,
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
		winner: null,
		...overrides
	};
}

export function kill(state: GameState, ...seats: Seat[]): GameState {
	for (const s of seats) {
		const p = state.players[s];
		if (p) p.isDead = true;
	}
	return state;
}
