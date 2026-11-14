import { describe, it, expect } from 'vitest';
import { produce } from 'immer';
import { startGame, reduce } from './engine';
import { pushShotStatus } from './reducers/day';
import { notifyRoleHolders } from './rules/turnContext';
import { buildSetup } from './rules/setup';
import { defaultRuleConfig, makeState, kill } from './testFixtures';
import type { EngineEffect, GameState, RoleId, Seat } from './types';

function effectsOfKind(effects: EngineEffect[], kind: string): EngineEffect[] {
	return effects.filter((e) => (e.payload as { kind?: string } | undefined)?.kind === kind);
}

function payload<T = Record<string, unknown>>(effect: EngineEffect | undefined): T {
	if (!effect) throw new Error('expected effect, got none');
	return effect.payload as T;
}

/** These flow tests were written against the old 遗言 defaults - keep them
 * on here so the LAST_WORDS queue stays covered now that the shipped
 * defaults turn it off. */
function lastWordsOnConfig() {
	const cfg = defaultRuleConfig();
	cfg.lastWords = {
		firstNightVictim: true,
		exiledPlayer: true,
		hunterShotVictim: true,
		nightVictimAfterFirst: false
	};
	// These tests drive the in-app HUNTER_SHOOT phase directly.
	cfg.shotsAtTable = false;
	return cfg;
}

function start(roles: Record<Seat, RoleId>) {
	const roleConfig: Partial<Record<RoleId, number>> = {};
	const players = Object.entries(roles).map(([seatStr, role]) => {
		const seat = Number(seatStr);
		roleConfig[role] = (roleConfig[role] ?? 0) + 1;
		return { seat, sessionId: `s${seat}`, nickname: `P${seat}` };
	});
	return startGame({
		roomCode: 'ABC123',
		ruleConfig: lastWordsOnConfig(),
		setup: buildSetup(roleConfig),
		deal: {
			identities: Object.fromEntries(Object.entries(roles).map(([s, r]) => [s, r])),
			buried: null
		},
		players,
		now: 1000
	});
}

describe('startGame', () => {
	it('deals private YourRole to every seat and broadcasts FIRST_NIGHT', () => {
		const { state, effects } = start({ 1: 'WEREWOLF', 2: 'SEER', 3: 'WITCH', 4: 'VILLAGER' });

		const roleEffects = effectsOfKind(effects, 'YourRole');
		expect(roleEffects).toHaveLength(4);
		expect(payload(roleEffects.find((e) => e.seat === 1)).role).toBe('WEREWOLF');
		expect(payload(roleEffects.find((e) => e.seat === 2)).role).toBe('SEER');

		expect(state.phase).toBe('FIRST_NIGHT');
		expect(state.round).toBe(1);
		expect(effectsOfKind(effects, 'PhaseChanged')).toHaveLength(1);
	});

	it('enters the first stage of the night order directly - no stage at all for an always-announced role nobody configured (GUARD)', () => {
		const { state, effects } = start({ 1: 'WEREWOLF', 2: 'SEER', 3: 'WITCH', 4: 'VILLAGER' });
		// GUARD was never configured on this board - unlike a configured role
		// whose holder just isn't alive YET (there is no such thing on night 1)
		// or died, an unconfigured role gets no stage at all: the room's
		// composition is public knowledge already (shown at setup), so there's
		// no inference to protect against by conjuring a phantom stage for a
		// role nobody was ever dealt.
		expect(state.currentStepKey).toBe('role:WEREWOLF');
		const stageChanged = effectsOfKind(effects, 'StageChanged');
		expect(payload<{ stage: unknown }>(stageChanged[0]).stage).toEqual({
			kind: 'ROLE_TURN',
			role: 'WEREWOLF'
		});
		const prompts = effectsOfKind(effects, 'YourTurnPrompt');
		expect(prompts).toHaveLength(1);
		expect(prompts[0].seat).toBe(1);
	});

	it('§8.5 假环节: a role that IS configured but never gets dealt to a living seat this game (WOLF_KING absent) still gets its own stage - a genuinely unconfigured role (GUARD) does not', () => {
		// Configuring WOLF_KING with 0 count isn't representable (roleConfig is
		// a presence map), so this instead exercises the always-announced set's
		// OTHER guarantee directly: SEER/WITCH/HUNTER are configured (1 each)
		// but none of the SEER/WITCH/HUNTER SEATS themselves are dealt to this
		// specific 3-seat board's identities below - impossible without a real
		// deal. Given that constraint, the meaningful contrast this test can
		// actually exercise is: GUARD (never configured at all) gets skipped
		// straight past, while WITCH/SEER/HUNTER (configured, so always
		// announced regardless of who's alive) each still get a real stage.
		let { state } = start({ 1: 'WEREWOLF', 2: 'WITCH', 3: 'SEER', 4: 'HUNTER', 5: 'VILLAGER' });
		expect(state.currentStepKey).toBe('role:WEREWOLF'); // GUARD skipped entirely - never configured
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 5 }
		}));
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		expect(state.currentStepKey).toBe('role:WITCH');
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 2,
			role: 'WITCH',
			action: {}
		}));
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		expect(state.currentStepKey).toBe('role:SEER');
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 3,
			role: 'SEER',
			action: { seerCheckTarget: 1 }
		}));
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		expect(state.currentStepKey).toBe('role:HUNTER');
		// WOLF_BEAUTY was never configured at all and isn't in the
		// always-announced set - it's genuinely absent, not just fake, so the
		// order is exhausted straight into DAWN from here.
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		expect(state.phase).toBe('DAWN');
	});

	it('§8.5 假环节: a configured always-announced role whose holder died still gets its own stage the following night', () => {
		// A second god (SEER) keeps SIDE_KILL from ending the game the instant
		// the guard dies on night 1 - this test is about the stage sequence on
		// night 2, which only exists to check if the game is still going.
		let { state } = start({
			1: 'WEREWOLF',
			2: 'GUARD',
			3: 'SEER',
			4: 'VILLAGER',
			5: 'VILLAGER'
		});
		expect(state.currentStepKey).toBe('role:GUARD'); // real - seat 2 is alive
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 2,
			role: 'GUARD',
			action: { guardTarget: 4 }
		}));
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' })); // -> WEREWOLF
		// Wolf kills the guard (seat 2), not the guarded seat.
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 2 }
		}));
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' })); // -> SEER (WITCH/HUNTER unconfigured, skipped)
		expect(state.currentStepKey).toBe('role:SEER');
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' })); // exhausted -> DAWN
		expect(state.phase).toBe('DAWN');
		expect(state.pendingNightDeaths).toEqual([{ seat: 2, cause: 'WOLF_KILL' }]);

		({ state } = reduce(state, { type: 'ANNOUNCE_NIGHT_RESULTS' }));
		({ state } = reduce(state, { type: 'NEXT_SPEAKER' })); // drain seat 2's last words (first-night victim)
		({ state } = reduce(state, { type: 'BEGIN_VOTE' }));
		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 1, target: 4 }));
		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 3, target: 4 }));
		({ state } = reduce(state, { type: 'TALLY_VOTES' })); // exiles seat 4
		expect(state.phase).toBe('LAST_WORDS'); // exiledPlayer default true
		({ state } = reduce(state, { type: 'NEXT_SPEAKER' })); // drain seat 4's last words -> night 2
		expect(state.phase).toBe('NIGHT');
		expect(state.round).toBe(2);

		// GUARD is still configured (seat 2 held it) even though its holder is
		// now dead - the stage must still appear tonight, exactly as if seat 2
		// were still alive, so the sequence itself never betrays the death.
		expect(state.currentStepKey).toBe('role:GUARD');
	});
});

describe('full game: night action -> witch save -> seer check -> vote -> GOOD wins', () => {
	it('plays out end to end with the expected effects at each step', () => {
		let { state } = start({ 1: 'WEREWOLF', 2: 'SEER', 3: 'WITCH', 4: 'VILLAGER' });
		let effects: EngineEffect[];
		expect(state.currentStepKey).toBe('role:WEREWOLF'); // GUARD not configured - skipped entirely

		// Wolf kills the villager.
		({ state, effects } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 4 }
		}));
		expect(effectsOfKind(effects, 'NightActionAck')).toHaveLength(1);
		expect(state.nightActions.wolfKillTarget).toBe(4);

		({ state, effects } = reduce(state, { type: 'ADVANCE_STAGE' }));
		expect(state.currentStepKey).toBe('role:WITCH');
		const witchPrompt = payload(effectsOfKind(effects, 'YourTurnPrompt')[0]) as {
			context: { witch: { killedSeat: number; antidoteAvailable: boolean } };
		};
		expect(witchPrompt.context.witch.killedSeat).toBe(4);
		expect(witchPrompt.context.witch.antidoteAvailable).toBe(true);

		// Witch saves the villager.
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 3,
			role: 'WITCH',
			action: { witchAntidoteTarget: 4 }
		}));
		expect(state.witchAntidoteUsed).toBe(true);

		// A second witch submission the same night is rejected.
		({ state, effects } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 3,
			role: 'WITCH',
			action: { witchPoisonTarget: 2 }
		}));
		const rejection = payload(effectsOfKind(effects, 'NightActionRejected')[0]) as {
			error: string;
		};
		expect(rejection.error).toBe('already_submitted');

		({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		expect(state.currentStepKey).toBe('role:SEER');

		// Seer checks the werewolf -> bad.
		({ state, effects } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 2,
			role: 'SEER',
			action: { seerCheckTarget: 1 }
		}));
		const seerResult = payload(effectsOfKind(effects, 'SeerResult')[0]) as {
			targetSeat: number;
			isBad: boolean;
		};
		expect(seerResult).toEqual({ kind: 'SeerResult', targetSeat: 1, isBad: true });

		// HUNTER not configured on this board - order exhausted straight into
		// DAWN with a saved villager (no deaths).
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		expect(state.phase).toBe('DAWN');
		expect(state.pendingNightDeaths).toEqual([]);

		({ state, effects } = reduce(state, { type: 'ANNOUNCE_NIGHT_RESULTS' }));
		expect(payload(effectsOfKind(effects, 'NightResultsAnnounced')[0])).toEqual({
			kind: 'NightResultsAnnounced',
			deaths: [],
			nightNumber: 1,
			silenced: null
		});
		// No deaths -> nobody needs last words - straight to DISCUSSION.
		expect(state.phase).toBe('DISCUSSION');
		expect(state.pendingNightDeaths).toBeNull();

		// Announcing again is a no-op (guards against a double tap).
		({ state, effects } = reduce(state, { type: 'ANNOUNCE_NIGHT_RESULTS' }));
		expect(effects).toEqual([]);

		// Host opens the vote.
		({ state } = reduce(state, { type: 'BEGIN_VOTE' }));
		expect(state.phase).toBe('VOTE');

		// Everyone votes out the werewolf.
		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 2, target: 1 }));
		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 3, target: 1 }));
		({ state, effects } = reduce(state, { type: 'CAST_VOTE', seat: 4, target: 1 }));
		expect(payload(effectsOfKind(effects, 'VoteUpdated')[0])).toEqual({
			kind: 'VoteUpdated',
			votedSeats: [2, 3, 4],
			totalVoters: 4
		});

		({ state, effects } = reduce(state, { type: 'TALLY_VOTES' }));
		const dayResolved = payload(effectsOfKind(effects, 'DayResolved')[0]) as {
			eliminatedSeat: number;
			identity: RoleId;
			tie: boolean;
		};
		expect(dayResolved).toMatchObject({ eliminatedSeat: 1, identity: null, tie: false }); // card stays face down

		// Zero wolves remain -> GOOD wins immediately.
		expect(state.phase).toBe('GAME_OVER');
		expect(state.winner).toBe('GOOD');
		expect(payload(effectsOfKind(effects, 'GameOver')[0])).toMatchObject({ winner: 'GOOD' });
	});
});

describe('hunter shoot flow', () => {
	it('a wolf-killed hunter is authorized to shoot back, and the game re-checks the winner immediately', () => {
		let { state } = start({ 1: 'HUNTER', 2: 'WEREWOLF', 3: 'VILLAGER', 4: 'VILLAGER' });
		expect(state.currentStepKey).toBe('role:WEREWOLF'); // GUARD not configured - skipped entirely

		let effects: EngineEffect[];
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 2,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 1 }
		}));

		// WITCH/SEER not configured on this board - straight to HUNTER's
		// informational turn.
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		expect(state.currentStepKey).toBe('role:HUNTER');

		({ state } = reduce(state, { type: 'ADVANCE_STAGE' })); // order exhausted -> DAWN
		expect(state.phase).toBe('DAWN');
		expect(state.pendingNightDeaths).toEqual([{ seat: 1, cause: 'WOLF_KILL' }]);

		({ state, effects } = reduce(state, { type: 'ANNOUNCE_NIGHT_RESULTS' }));
		expect(effectsOfKind(effects, 'HunterDenied')).toHaveLength(0); // wolf-killed, not poisoned - eligible
		// First-night victim -> last words before the hunter gets to shoot.
		expect(state.phase).toBe('LAST_WORDS');
		expect(state.pendingLastWords).toEqual([1]);

		({ state, effects } = reduce(state, { type: 'NEXT_SPEAKER' }));
		expect(state.phase).toBe('HUNTER_SHOOT');
		expect(state.pendingShoots).toEqual([1]);
		expect(payload(effectsOfKind(effects, 'HunterPending')[0])).toEqual({
			kind: 'HunterPending',
			hunterSeat: 1
		});
		expect(effectsOfKind(effects, 'HunterAuthorized')[0].seat).toBe(1);

		({ state, effects } = reduce(state, { type: 'HUNTER_SHOOT', shooterSeat: 1, targetSeat: 2 }));
		const resolved = payload(effectsOfKind(effects, 'HunterResolved')[0]) as {
			hunterSeat: number;
			shotSeat: number;
			followDeathSeat: number | null;
		};
		expect(resolved).toEqual({
			kind: 'HunterResolved',
			hunterSeat: 1,
			shotSeat: 2,
			followDeathSeat: null
		});
		expect(state.players[2].isDead).toBe(true);
		expect(state.players[2].deathCause).toBe('HUNTER_SHOT');

		// Both the hunter and the wolf are gone, but zero wolves remain -> GOOD wins.
		expect(state.phase).toBe('GAME_OVER');
		expect(state.winner).toBe('GOOD');
	});

	it('a poisoned hunter is denied and never enters HUNTER_SHOOT', () => {
		// A second villager (seat 5) keeps SIDE_KILL from resolving the game the
		// instant seat 4 dies - this test is about hunter-shot eligibility, not
		// the win condition.
		let { state } = start({ 1: 'HUNTER', 2: 'WITCH', 3: 'WEREWOLF', 4: 'VILLAGER', 5: 'VILLAGER' });
		expect(state.currentStepKey).toBe('role:WEREWOLF'); // GUARD not configured - skipped entirely
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 3,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 4 }
		}));
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' })); // -> WITCH
		expect(state.currentStepKey).toBe('role:WITCH');
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 2,
			role: 'WITCH',
			action: { witchPoisonTarget: 1 }
		}));
		// SEER isn't configured on this board - skipped entirely, straight to HUNTER.
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' })); // -> HUNTER
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' })); // exhausted -> DAWN

		const announced = reduce(state, { type: 'ANNOUNCE_NIGHT_RESULTS' });
		state = announced.state;
		expect(payload(effectsOfKind(announced.effects, 'HunterDenied')[0])).toEqual({
			kind: 'HunterDenied',
			reason: 'poison'
		});
		// First-night victims (seat 1 poisoned, seat 4 wolf-killed) -> both get
		// last words, seat-ascending (B42), even though seat 1 is denied a shot.
		expect(state.phase).toBe('LAST_WORDS');
		expect(state.pendingLastWords).toEqual([1, 4]);

		({ state } = reduce(state, { type: 'NEXT_SPEAKER' }));
		expect(state.phase).toBe('LAST_WORDS');
		({ state } = reduce(state, { type: 'NEXT_SPEAKER' }));
		expect(state.phase).toBe('DISCUSSION'); // never entered HUNTER_SHOOT
	});
});

describe('third-party lovers win (Cupid trio)', () => {
	it('a cross-camp couple linked by Cupid wins alone once everyone else is dead, including a lone surviving Cupid', () => {
		let { state } = start({ 1: 'WEREWOLF', 2: 'VILLAGER', 3: 'CUPID' });
		expect(state.currentStepKey).toBe('role:CUPID');

		let effects: EngineEffect[];
		({ state, effects } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 3,
			role: 'CUPID',
			action: { cupidLinks: [1, 2] }
		}));
		expect(state.lovers).toEqual([1, 2]);
		const revealed = effectsOfKind(effects, 'CoupleRevealed');
		expect(revealed).toHaveLength(2);
		expect(payload(revealed.find((e) => e.seat === 1))).toEqual({
			kind: 'CoupleRevealed',
			partnerSeat: 2
		});

		({ state } = reduce(state, { type: 'ADVANCE_STAGE' })); // -> COUPLE_REVEAL
		expect(state.currentStepKey).toBe('couple_reveal');
		// GUARD/WITCH/SEER/HUNTER aren't configured on this board at all -
		// WEREWOLF is the only other stage in the order.
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' })); // -> WEREWOLF

		// Wolf kills their own linked partner - both lovers die via LOVER_SUICIDE cascade.
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 2 }
		}));
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' })); // exhausted -> DAWN
		expect(state.pendingNightDeaths).toEqual([
			{ seat: 2, cause: 'WOLF_KILL' },
			{ seat: 1, cause: 'LOVER_SUICIDE' }
		]);

		({ state, effects } = reduce(state, { type: 'ANNOUNCE_NIGHT_RESULTS' }));
		expect(state.phase).toBe('GAME_OVER');
		expect(state.winner).toBe('LOVERS');
		expect(payload(effectsOfKind(effects, 'GameOver')[0])).toMatchObject({
			winner: 'LOVERS',
			coupleSeats: [1, 2]
		});
	});
});

describe('§9.4 平票处理: a tied vote opens VOTE_PK (tieBreak=PK_THEN_NO_EXILE default)', () => {
	function toDayVote() {
		let { state } = start({ 1: 'WEREWOLF', 2: 'VILLAGER', 3: 'VILLAGER', 4: 'VILLAGER' });
		// Skip straight through an uneventful night - GUARD/WEREWOLF/WITCH/SEER/
		// HUNTER all get a stage (真 or 假环节) before the order exhausts.
		for (let i = 0; i < 5; i++) {
			({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		}
		({ state } = reduce(state, { type: 'ANNOUNCE_NIGHT_RESULTS' }));
		({ state } = reduce(state, { type: 'BEGIN_VOTE' }));
		return state;
	}

	it('a re-tied PK round elects nobody and the game continues into the next night ("仅一轮")', () => {
		let state = toDayVote();

		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 2, target: 1 }));
		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 3, target: 4 }));
		const firstTally = reduce(state, { type: 'TALLY_VOTES' });
		state = firstTally.state;

		const firstResolved = payload(effectsOfKind(firstTally.effects, 'DayResolved')[0]) as {
			eliminatedSeat: null;
			tie: boolean;
			pkCandidates: number[];
		};
		expect(firstResolved).toMatchObject({ eliminatedSeat: null, tie: true, pkCandidates: [1, 4] });
		expect(state.phase).toBe('VOTE_PK');
		expect(state.pkCandidates).toEqual([1, 4]);
		expect(state.votes).toEqual({}); // reset for the PK round

		// Candidates (1, 4) can't vote in their own PK; seats 2/3 split again.
		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 1, target: 4 }));
		expect(state.votes).toEqual({}); // rejected - a PK candidate can't vote
		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 2, target: 3 }));
		expect(state.votes).toEqual({}); // rejected - 3 isn't a PK candidate
		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 2, target: 1 }));
		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 3, target: 4 }));

		const secondTally = reduce(state, { type: 'TALLY_VOTES' });
		state = secondTally.state;
		const secondResolved = payload(effectsOfKind(secondTally.effects, 'DayResolved')[0]) as {
			eliminatedSeat: null;
			tie: boolean;
		};
		expect(secondResolved).toMatchObject({ eliminatedSeat: null, tie: true });
		expect(state.phase).toBe('NIGHT'); // re-tied - nobody exiled, straight to night
		expect(state.round).toBe(2);
		expect(state.isFirstNight).toBe(false);
	});

	it('a PK round with a unique winner exiles them', () => {
		let state = toDayVote();
		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 2, target: 1 }));
		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 3, target: 4 }));
		({ state } = reduce(state, { type: 'TALLY_VOTES' }));
		expect(state.phase).toBe('VOTE_PK');

		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 2, target: 1 }));
		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 3, target: 1 }));
		const tallied = reduce(state, { type: 'TALLY_VOTES' });
		state = tallied.state;

		const resolved = payload(effectsOfKind(tallied.effects, 'DayResolved')[0]) as {
			eliminatedSeat: number;
			identity: string;
		};
		expect(resolved).toMatchObject({ eliminatedSeat: 1, identity: null });
		// Zero wolves remain -> GOOD wins immediately.
		expect(state.phase).toBe('GAME_OVER');
		expect(state.winner).toBe('GOOD');
	});

	it("tieBreak='NO_EXILE': a first-round tie skips PK entirely, straight to night", () => {
		const cfg = { ...defaultRuleConfig(), tieBreak: 'NO_EXILE' as const };
		let state = toDayVote();
		state = { ...state, ruleConfig: cfg };

		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 2, target: 1 }));
		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 3, target: 4 }));
		const tallied = reduce(state, { type: 'TALLY_VOTES' });
		state = tallied.state;

		expect(payload(effectsOfKind(tallied.effects, 'DayResolved')[0])).toMatchObject({
			eliminatedSeat: null,
			tie: true
		});
		expect(state.phase).toBe('NIGHT');
		expect(state.round).toBe(2);
	});
});

describe('CAST_VOTE guards', () => {
	it('a dead seat cannot vote', () => {
		let { state } = start({ 1: 'WEREWOLF', 2: 'VILLAGER', 3: 'VILLAGER' });
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		({ state } = reduce(state, { type: 'ANNOUNCE_NIGHT_RESULTS' }));
		state = {
			...state,
			players: { ...state.players, 2: { ...state.players[2], isDead: true } }
		} as GameState;

		const { state: after, effects } = reduce(state, { type: 'CAST_VOTE', seat: 2, target: 1 });
		expect(effects).toEqual([]);
		expect(after.votes).toEqual({});
	});
});

describe('IDIOT reveal-on-exile (§9.5, B16-B19, UT-10)', () => {
	it('an exiled idiot reveals instead of dying, loses their vote, keeps their seat, and the day skips straight to the next night', () => {
		const state = makeState(
			{ 1: 'IDIOT', 2: 'WEREWOLF', 3: 'VILLAGER', 4: 'VILLAGER' },
			{ phase: 'VOTE', votes: { 2: 1, 3: 1, 4: 1 } }
		);
		const { state: after, effects } = reduce(state, { type: 'TALLY_VOTES' });

		expect(after.players[1].isDead).toBe(false);
		expect(after.players[1].isRevealedIdiot).toBe(true);
		expect(after.players[1].revealedRole).toBe('IDIOT');
		expect(after.players[1].hasVoteRight).toBe(false);
		expect(after.phase).toBe('NIGHT'); // "当天不再重投" - straight to the next night
		expect(after.round).toBe(2);

		const dayResolved = payload(effectsOfKind(effects, 'DayResolved')[0]) as {
			eliminatedSeat: number;
			idiotRevealed: boolean;
		};
		expect(dayResolved).toMatchObject({ eliminatedSeat: 1, idiotRevealed: true });
	});

	it('UT-11: a revealed, still-alive idiot still counts as a living god - SIDE_KILL does not trigger', () => {
		let state = makeState(
			{ 1: 'WEREWOLF', 2: 'IDIOT', 3: 'SEER', 4: 'VILLAGER' },
			{ phase: 'VOTE', votes: { 1: 2, 3: 2, 4: 2 } } // everyone votes out the idiot
		);
		state = kill(structuredClone(state), 3); // the seer already died earlier - idiot is now the only living god

		const { state: after } = reduce(state, { type: 'TALLY_VOTES' });

		expect(after.players[2].isRevealedIdiot).toBe(true);
		expect(after.players[2].isDead).toBe(false);
		// Without the idiot counting as a living god, SIDE_KILL would see zero
		// living gods and hand the wolves an immediate win - it must not.
		expect(after.winner).toBeNull();
		expect(after.phase).toBe('NIGHT');
	});

	it('a revealed idiot exiled again later has no further effect (B19) - falls through to a normal VOTE_OUT death, since a second reveal never happens here', () => {
		// Once revealed, `!eliminatedPlayer.isRevealedIdiot` is false, so the
		// branch that protects them no longer applies - matching B19's "仍不死"
		// only in the sense that the spec's actual mechanism (SHOULD-level host
		// prompt) is a day-phase UI concern for M5, not reachable purely from
		// TALLY_VOTES. This test documents the current (engine-only) fallthrough
		// behavior rather than asserting the SHOULD-level UX.
		const state = makeState(
			{ 1: 'IDIOT', 2: 'VILLAGER', 3: 'VILLAGER' },
			{ phase: 'VOTE', votes: { 2: 1, 3: 1 } }
		);
		state.players[1].isRevealedIdiot = true;
		const { state: after } = reduce(state, { type: 'TALLY_VOTES' });
		expect(after.players[1].isDead).toBe(true);
		expect(after.players[1].deathCause).toBe('VOTE_OUT');
	});
});

describe('SELF_EXPLODE (§9.6)', () => {
	it('a regular werewolf self-explodes: dies, the day is decided (selfExplodeEndsDay default true)', () => {
		// A second, surviving wolf keeps this from also being an immediate GOOD
		// win - the point of this test is the phase transition, not the tally.
		const state = makeState(
			{ 1: 'WEREWOLF', 2: 'WEREWOLF', 3: 'VILLAGER', 4: 'VILLAGER' },
			{ phase: 'DISCUSSION' }
		);
		const { state: after, effects } = reduce(state, { type: 'SELF_EXPLODE', seat: 1 });

		expect(after.players[1].isDead).toBe(true);
		expect(after.players[1].deathCause).toBe('SELF_EXPLODE');
		expect(payload(effectsOfKind(effects, 'SelfExploded')[0])).toMatchObject({ seat: 1 });
		// The day is over (no exile possible) but waits for the host's 进入下一夜.
		expect(after.phase).toBe('DISCUSSION');
		expect(after.dayDecided).toBe(true);
		expect(reduce(after, { type: 'EXILE', seat: 3 }).effects).toEqual([]);
		const night = reduce(after, { type: 'END_DAY' }).state;
		expect(night.phase).toBe('NIGHT');
		expect(night.round).toBe(2);
	});

	it("a new night forgets the last round's news, so a reload cannot bring it back", () => {
		const state = makeState(
			{ 1: 'WEREWOLF', 2: 'VILLAGER' },
			{
				phase: 'DISCUSSION',
				announcedNightDeaths: [2],
				announcedDayResult: {
					eliminatedSeat: 2,
					identity: null,
					tie: false,
					followDeathSeat: null,
					followDeathIdentity: null,
					idiotRevealed: false
				}
			}
		);
		const night = reduce(state, { type: 'END_DAY' }).state;
		expect(night.announcedNightDeaths).toBeUndefined();
		expect(night.announcedDayResult).toBeUndefined();
	});

	it('rejects a non-wolf seat trying to self-explode (server-side camp check)', () => {
		const state = makeState({ 1: 'WEREWOLF', 2: 'VILLAGER' }, { phase: 'DISCUSSION' });
		const { state: after, effects } = reduce(state, { type: 'SELF_EXPLODE', seat: 2 });
		expect(after.players[2].isDead).toBe(false);
		expect(effects).toEqual([]);
	});

	it('UT-21: a wolf-king explosion queues a shot; resolving it returns to the decided day', () => {
		// A second wolf (seat 2) survives both the explosion and the shot (which
		// targets a villager instead), so the win check doesn't preempt the
		// phase-transition assertions below.
		const state = makeState(
			{ 1: 'WOLF_KING', 2: 'WEREWOLF', 3: 'VILLAGER', 4: 'VILLAGER' },
			{ phase: 'DISCUSSION' }
		);
		const exploded = reduce(state, { type: 'SELF_EXPLODE', seat: 1 });

		expect(exploded.state.players[1].isDead).toBe(true);
		expect(exploded.state.players[1].deathCause).toBe('SELF_EXPLODE');
		expect(exploded.state.phase).toBe('HUNTER_SHOOT');
		expect(exploded.state.pendingShoots).toEqual([1]);

		const shot = reduce(exploded.state, { type: 'HUNTER_SHOOT', shooterSeat: 1, targetSeat: 4 });
		expect(shot.state.players[4].isDead).toBe(true);
		expect(shot.state.players[4].deathCause).toBe('WOLF_KING_SHOT');
		// Back to the (decided) day - no exile, the host starts the night.
		expect(shot.state.phase).toBe('DISCUSSION');
		expect(shot.state.dayDecided).toBe(true);
		const { state: after } = reduce(shot.state, { type: 'END_DAY' });
		expect(after.phase).toBe('NIGHT');
		expect(after.round).toBe(2);
	});

	it('wolfKingExplodeCanShoot = false: no shot queued, day decided', () => {
		const cfg = {
			...defaultRuleConfig(),
			wolf: { ...defaultRuleConfig().wolf, wolfKingExplodeCanShoot: false }
		};
		const state = makeState(
			{ 1: 'WOLF_KING', 2: 'WEREWOLF', 3: 'VILLAGER' },
			{ phase: 'DISCUSSION', ruleConfig: cfg }
		);
		const { state: after } = reduce(state, { type: 'SELF_EXPLODE', seat: 1 });
		expect(after.pendingShoots).toEqual([]);
		expect(after.phase).toBe('DISCUSSION');
		expect(after.dayDecided).toBe(true);
	});
});

describe('KNIGHT_DUEL (§9.6, UT-22)', () => {
	it('B29: duel reveals a wolf - wolf dies, duel decides the day (duelEndsDayIfWolf default true)', () => {
		// A second wolf survives the duel so this stays mid-game (not an
		// incidental GOOD win) - the assertions are about the phase transition.
		const state = makeState(
			{ 1: 'KNIGHT', 2: 'WEREWOLF', 3: 'WEREWOLF', 4: 'VILLAGER' },
			{ phase: 'DISCUSSION' }
		);
		const { state: after, effects } = reduce(state, {
			type: 'KNIGHT_DUEL',
			knightSeat: 1,
			targetSeat: 2
		});

		expect(after.players[2].isDead).toBe(true);
		expect(after.players[2].deathCause).toBe('KNIGHT_DUEL');
		expect(after.players[2].revealedRole).toBe('WEREWOLF');
		expect(after.knightUsed).toBe(true);
		expect(after.phase).toBe('DISCUSSION');
		expect(after.dayDecided).toBe(true);

		const resolved = payload(effectsOfKind(effects, 'KnightDuelResolved')[0]) as {
			targetWasWolf: boolean;
		};
		expect(resolved.targetWasWolf).toBe(true);
	});

	it('B30: duel reveals a good player - knight dies instead, day continues to a normal vote', () => {
		// The knight was the only god on this board - by itself, its death would
		// also trip SIDE_KILL's "all gods dead" branch. Padding with extra
		// villagers keeps that from masking the phase assertion below; TOTAL_KILL
		// sidesteps it more directly (1 wolf vs. 3 goods stays under the bar).
		const cfg = { ...defaultRuleConfig(), winCondition: 'TOTAL_KILL' as const };
		const state = makeState(
			{ 1: 'KNIGHT', 2: 'VILLAGER', 3: 'VILLAGER', 4: 'VILLAGER', 5: 'WEREWOLF' },
			{ phase: 'DISCUSSION', ruleConfig: cfg }
		);
		const { state: after } = reduce(state, { type: 'KNIGHT_DUEL', knightSeat: 1, targetSeat: 2 });

		expect(after.players[1].isDead).toBe(true);
		expect(after.players[1].deathCause).toBe('KNIGHT_DUEL_FAIL');
		expect(after.players[2].isDead).toBe(false);
		expect(after.players[2].revealedRole).toBe('VILLAGER');
		expect(after.phase).toBe('DISCUSSION');
	});

	it('B31: duel target is a cross-camp couple wolf - wolf dies, partner follows via LOVER_SUICIDE, day decided', () => {
		// A second wolf (seat 4) survives so killing the linked wolf isn't also
		// an incidental GOOD win - B31's "立即进夜" outcome assumes the game
		// keeps going, which only shows up if it doesn't end here.
		const state = makeState(
			{ 1: 'KNIGHT', 2: 'WEREWOLF', 3: 'VILLAGER', 4: 'WEREWOLF', 5: 'VILLAGER' },
			{ phase: 'DISCUSSION', lovers: [2, 3] }
		);
		const { state: after } = reduce(state, { type: 'KNIGHT_DUEL', knightSeat: 1, targetSeat: 2 });

		expect(after.players[2].isDead).toBe(true);
		expect(after.players[2].deathCause).toBe('KNIGHT_DUEL');
		expect(after.players[3].isDead).toBe(true);
		expect(after.players[3].deathCause).toBe('LOVER_SUICIDE');
		expect(after.phase).toBe('DISCUSSION');
		expect(after.dayDecided).toBe(true);
	});

	it('onceOnly: rejected outright once knightUsed is already true', () => {
		const state = makeState(
			{ 1: 'KNIGHT', 2: 'WEREWOLF' },
			{ phase: 'DISCUSSION', knightUsed: true }
		);
		const { state: after, effects } = reduce(state, {
			type: 'KNIGHT_DUEL',
			knightSeat: 1,
			targetSeat: 2
		});
		expect(effects).toEqual([]);
		expect(after.players[2].isDead).toBe(false);
	});

	it('knightDiesIfGood = false house rule: the knight survives a failed duel, still revealed', () => {
		const cfg = {
			...defaultRuleConfig(),
			knight: { ...defaultRuleConfig().knight, knightDiesIfGood: false }
		};
		const state = makeState(
			{ 1: 'KNIGHT', 2: 'VILLAGER' },
			{ phase: 'DISCUSSION', ruleConfig: cfg }
		);
		const { state: after } = reduce(state, { type: 'KNIGHT_DUEL', knightSeat: 1, targetSeat: 2 });
		expect(after.players[1].isDead).toBe(false);
		expect(after.players[1].revealedRole).toBe('KNIGHT');
	});
});

describe('hunter chain-shot (UT-09 / B14)', () => {
	it('a hunter shot kills another hunter, who then gets to shoot too', () => {
		let { state } = start({
			1: 'HUNTER',
			2: 'WEREWOLF',
			3: 'HUNTER',
			4: 'VILLAGER',
			5: 'VILLAGER'
		});

		// No guard/witch/seer configured, so the night opens on WEREWOLF.
		expect(state.currentStepKey).toBe('role:WEREWOLF');
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 2,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 1 }
		}));
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' })); // -> HUNTER's informational turn
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' })); // exhausted -> DAWN
		({ state } = reduce(state, { type: 'ANNOUNCE_NIGHT_RESULTS' }));
		// First-night victim -> last words before the hunter gets to shoot.
		expect(state.phase).toBe('LAST_WORDS');
		expect(state.pendingLastWords).toEqual([1]);
		({ state } = reduce(state, { type: 'NEXT_SPEAKER' }));
		expect(state.phase).toBe('HUNTER_SHOOT');
		expect(state.pendingShoots).toEqual([1]);

		const firstShot = reduce(state, { type: 'HUNTER_SHOOT', shooterSeat: 1, targetSeat: 3 });
		state = firstShot.state;
		expect(state.players[3].isDead).toBe(true);
		expect(state.players[3].deathCause).toBe('HUNTER_SHOT');
		// lastWords.hunterShotVictim (default true) - seat 3 gets last words
		// before their own chain-shot (canTriggerShoot always allows a
		// HUNTER_SHOT-caused death to fire back).
		expect(state.phase).toBe('LAST_WORDS');
		expect(state.pendingLastWords).toEqual([3]);
		expect(effectsOfKind(firstShot.effects, 'LastWordsSpeakerChanged')).toHaveLength(1);

		({ state } = reduce(state, { type: 'NEXT_SPEAKER' }));
		expect(state.phase).toBe('HUNTER_SHOOT');
		expect(state.pendingShoots).toEqual([3]);

		({ state } = reduce(state, { type: 'HUNTER_SHOOT', shooterSeat: 3, targetSeat: 2 }));
		expect(state.players[2].isDead).toBe(true);
		expect(state.players[2].deathCause).toBe('HUNTER_SHOT');
		// Zero wolves remain -> GOOD wins immediately.
		expect(state.phase).toBe('GAME_OVER');
		expect(state.winner).toBe('GOOD');
	});
});

describe('WOLF_KING shares the collective wolf-kill turn (no separate stage)', () => {
	it('a board with WEREWOLF + WOLF_KING has exactly one wolf-kill stage, and WOLF_KING can submit into it', () => {
		let { state, effects } = start({
			1: 'WEREWOLF',
			2: 'WOLF_KING',
			3: 'SEER',
			4: 'VILLAGER',
			5: 'VILLAGER'
		});
		// GUARD not configured - skipped entirely, WEREWOLF is the first stage.
		expect(state.currentStepKey).toBe('role:WEREWOLF');

		// Both wolf-team seats got a private prompt from the single WEREWOLF
		// stage, each tagged with their own actual role.
		const prompts = effectsOfKind(effects, 'YourTurnPrompt');
		expect(prompts.map((p) => p.seat).sort()).toEqual([1, 2]);
		expect(payload(prompts.find((p) => p.seat === 2)!).role).toBe('WOLF_KING');

		({ state, effects } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 2,
			role: 'WOLF_KING',
			action: { wolfKillTarget: 4 }
		}));
		expect(state.nightActions.wolfKillTarget).toBe(4);
		expect(effectsOfKind(effects, 'NightActionAck')).toHaveLength(1);

		// No second wolf stage, and WITCH isn't configured on this board either -
		// skipped straight to SEER (real).
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		expect(state.currentStepKey).toBe('role:SEER');
	});

	it('multiple werewolves each get their own prompt, but the first submission wins - a later one is rejected outright, not silently overwritten', () => {
		const { state, effects } = start({
			1: 'WEREWOLF',
			2: 'WEREWOLF',
			3: 'VILLAGER',
			4: 'VILLAGER',
			5: 'VILLAGER'
		});
		expect(state.currentStepKey).toBe('role:WEREWOLF');
		const prompts = effectsOfKind(effects, 'YourTurnPrompt');
		expect(prompts.map((p) => p.seat).sort()).toEqual([1, 2]);

		const firstSubmit = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 3 }
		});
		expect(firstSubmit.state.nightActions.wolfKillTarget).toBe(3);
		expect(effectsOfKind(firstSubmit.effects, 'NightActionAck')).toHaveLength(1);

		// Seat 2, a different werewolf, tries to submit a different target -
		// rejected, and the first wolf's target is left untouched.
		const secondSubmit = reduce(firstSubmit.state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 2,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 4 }
		});
		expect(
			payload<{ error: string }>(effectsOfKind(secondSubmit.effects, 'NightActionRejected')[0])
				.error
		).toBe('already_submitted');
		expect(secondSubmit.state.nightActions.wolfKillTarget).toBe(3); // unchanged
	});

	it('a WOLF_KING submission after a plain WEREWOLF already submitted is also rejected (shared decision, cross-role)', () => {
		const { state } = start({
			1: 'WEREWOLF',
			2: 'WOLF_KING',
			3: 'VILLAGER',
			4: 'VILLAGER',
			5: 'VILLAGER'
		});
		const firstSubmit = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 3 }
		});
		const secondSubmit = reduce(firstSubmit.state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 2,
			role: 'WOLF_KING',
			action: { wolfKillTarget: 4 }
		});
		expect(
			payload<{ error: string }>(effectsOfKind(secondSubmit.effects, 'NightActionRejected')[0])
				.error
		).toBe('already_submitted');
		expect(secondSubmit.state.nightActions.wolfKillTarget).toBe(3);
	});
});

describe('ADVANCE_STAGE staleness guard (expectedStepKey)', () => {
	it('a stale delayed auto-advance (stage already moved on) is a safe no-op', () => {
		// GUARD configured (and alive) here specifically so 'role:GUARD' is a
		// genuine real first stage to test staleness against.
		let { state } = start({ 1: 'WEREWOLF', 2: 'GUARD', 3: 'SEER', 4: 'WITCH', 5: 'VILLAGER' });
		expect(state.currentStepKey).toBe('role:GUARD');

		// Simulate: the host manually advances (or another player's own timer
		// wins the race) while a stale auto-advance timer is still pending.
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		expect(state.currentStepKey).toBe('role:WEREWOLF');

		// The stale timer fires, still holding the OLD key from before the
		// manual advance above - it must not push past WEREWOLF to SEER.
		const { state: after, effects } = reduce(state, {
			type: 'ADVANCE_STAGE',
			expectedStepKey: 'role:GUARD'
		});
		expect(after.currentStepKey).toBe('role:WEREWOLF'); // unchanged
		expect(effects).toEqual([]);
	});

	it('a matching expectedStepKey advances normally', () => {
		const { state } = start({ 1: 'WEREWOLF', 2: 'GUARD', 3: 'SEER', 4: 'WITCH', 5: 'VILLAGER' });
		const { state: after } = reduce(state, {
			type: 'ADVANCE_STAGE',
			expectedStepKey: 'role:GUARD'
		});
		expect(after.currentStepKey).toBe('role:WEREWOLF');
	});

	it('omitting expectedStepKey (a host manual tap) always advances regardless of staleness', () => {
		let { state } = start({ 1: 'WEREWOLF', 2: 'GUARD', 3: 'SEER', 4: 'WITCH', 5: 'VILLAGER' });
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		expect(state.currentStepKey).toBe('role:WEREWOLF');
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' })); // no expectedStepKey at all
		expect(state.currentStepKey).toBe('role:WITCH'); // WITCH (30) precedes SEER (40)
	});
});

describe('M7: WILD_CHILD conversion (T3, UT-23)', () => {
	it("the wild child's idol dying converts them to WEREWOLF camp, and the win check recounts immediately", () => {
		let { state } = start({
			1: 'WEREWOLF',
			2: 'VILLAGER',
			3: 'WILD_CHILD',
			4: 'VILLAGER',
			5: 'VILLAGER'
		});
		expect(state.currentStepKey).toBe('role:WILD_CHILD');

		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 3,
			role: 'WILD_CHILD',
			action: { wildChildIdol: 2 }
		}));
		expect(state.wildChildSeat).toBe(3);
		expect(state.wildChildIdol).toBe(2);

		// GUARD not configured - skipped entirely.
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' })); // -> WEREWOLF
		expect(state.currentStepKey).toBe('role:WEREWOLF');
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 2 }
		}));

		// WITCH/SEER/HUNTER not configured either - order exhausted -> DAWN.
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		expect(state.phase).toBe('DAWN');
		expect(state.pendingNightDeaths).toEqual([{ seat: 2, cause: 'WOLF_KILL' }]);
		// T3 already fired inside resolveNightPhase's own cascadeDeaths call.
		expect(state.players[3].convertedToWolf).toBe(true);

		const { state: after } = reduce(state, { type: 'ANNOUNCE_NIGHT_RESULTS' });
		// B34: the only original god (WILD_CHILD) just left the good camp -
		// SIDE_KILL's "all gods dead" branch fires immediately, before even
		// checking last words (a decided game skips them - see
		// enterHunterShootOrContinue's own comment).
		expect(after.phase).toBe('GAME_OVER');
		expect(after.winner).toBe('WEREWOLF');
	});
});

describe('野孩子 whose idol dies (joinsPack switch)', () => {
	const board = {
		1: 'WEREWOLF',
		2: 'VILLAGER',
		3: 'WILD_CHILD',
		4: 'VILLAGER',
		5: 'SEER',
		6: 'VILLAGER',
		7: 'WITCH'
	} as const;

	/** Night 1 with seat 3 idolising seat 2 and the wolves killing `victim`. */
	function toDawn(victim: number, joinsPack = true) {
		let { state } = start(board);
		state = {
			...state,
			ruleConfig: { ...state.ruleConfig, wildChild: { ...state.ruleConfig.wildChild, joinsPack } }
		};
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 3,
			role: 'WILD_CHILD',
			action: { wildChildIdol: 2 }
		}));
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'WEREWOLF',
			action: { wolfKillTarget: victim }
		}));
		while (state.phase !== 'DAWN') ({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		return state;
	}

	/** This spec's games have 遗言 on: the Host taps through it. */
	function pastLastWords(state: GameState): GameState {
		while (state.phase === 'LAST_WORDS') ({ state } = reduce(state, { type: 'NEXT_SPEAKER' }));
		return state;
	}

	it('by default only changes camp: never told, keeps the 野孩子 card, sleeps through the wolves', () => {
		const announced = reduce(toDawn(2, false), { type: 'ANNOUNCE_NIGHT_RESULTS' });
		expect(effectsOfKind(announced.effects, 'WildChildConverted')).toHaveLength(0);
		expect(announced.state.players[3].role).toBe('WILD_CHILD');
		expect(announced.state.players[3].convertedToWolf).toBe(true);

		const night2 = reduce(pastLastWords(announced.state), { type: 'END_DAY' });
		const prompts = effectsOfKind(night2.effects, 'YourTurnPrompt');
		expect(prompts.map((e) => e.seat)).toEqual([1]);
	});

	it('when on, is told only once the idol’s death is announced, then wakes with the wolves', () => {
		const dawn = toDawn(2);
		// Held back with the night's news: telling them now would leak it.
		const early = reduce(dawn, { type: 'HOST_OVERRIDE', kind: 'REVIVE', seat: 6 });
		expect(effectsOfKind(early.effects, 'WildChildConverted')).toHaveLength(0);

		const announced = reduce(dawn, { type: 'ANNOUNCE_NIGHT_RESULTS' });
		const told = effectsOfKind(announced.effects, 'WildChildConverted');
		expect(told.map((e) => e.seat)).toEqual([3]);
		expect(
			effectsOfKind(announced.effects, 'YourRole').some(
				(e) => e.seat === 3 && payload<{ role: string }>(e).role === 'WEREWOLF'
			)
		).toBe(true);

		const night2 = reduce(pastLastWords(announced.state), { type: 'END_DAY' });
		expect(night2.state.currentStepKey).toBe('role:WEREWOLF');
		const prompts = effectsOfKind(night2.effects, 'YourTurnPrompt');
		expect(prompts.map((e) => e.seat).sort()).toEqual([1, 3]);
		const mine = payload<{ context: { wolf: { teammateSeats: number[] } } }>(
			prompts.find((e) => e.seat === 1)
		);
		expect(mine.context.wolf.teammateSeats).toEqual([3]);
	});

	it('is told nothing while the idol lives, and is still shown as 野孩子 at the end', () => {
		const dawn = toDawn(4);
		const announced = reduce(dawn, { type: 'ANNOUNCE_NIGHT_RESULTS' });
		expect(effectsOfKind(announced.effects, 'WildChildConverted')).toHaveLength(0);

		// The idol dies by day: told at once. Then the game ends.
		const out = reduce(pastLastWords(announced.state), { type: 'DAY_OUT', seats: [2] });
		expect(effectsOfKind(out.effects, 'WildChildConverted').map((e) => e.seat)).toEqual([3]);
		let state = out.state;
		({ state } = reduce(state, { type: 'HOST_OVERRIDE', kind: 'KILL', seat: 1 }));
		const end = reduce(state, { type: 'HOST_OVERRIDE', kind: 'KILL', seat: 3 });
		expect(end.state.phase).toBe('GAME_OVER');
		const over = payload<{ identities: Record<number, string> }>(
			effectsOfKind(end.effects, 'GameOver')[0]
		);
		expect(over.identities[3]).toBe('WILD_CHILD');
	});
});

describe('M7: THIEF forced wolf pick (UT-24)', () => {
	it('both buried cards being wolf roles rejects "keep original identity"; picking one succeeds', () => {
		const roleConfig: Partial<Record<RoleId, number>> = {
			THIEF: 1,
			VILLAGER: 2,
			WEREWOLF: 1,
			WOLF_KING: 1
		};
		const { state: initial } = startGame({
			roomCode: 'ABC123',
			ruleConfig: defaultRuleConfig(),
			setup: buildSetup(roleConfig),
			deal: {
				identities: { '1': 'THIEF', '2': 'VILLAGER', '3': 'VILLAGER' },
				buried: ['WEREWOLF', 'WOLF_KING']
			},
			players: [
				{ seat: 1, sessionId: 's1', nickname: 'P1' },
				{ seat: 2, sessionId: 's2', nickname: 'P2' },
				{ seat: 3, sessionId: 's3', nickname: 'P3' }
			],
			now: 1000
		});
		expect(initial.currentStepKey).toBe('role:THIEF');
		expect(initial.players[1].thiefExtraCards).toEqual(['WEREWOLF', 'WOLF_KING']);

		const declined = reduce(initial, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'THIEF',
			action: {}
		});
		expect(declined.state.players[1].role).toBe('THIEF'); // unchanged
		expect(
			payload<{ error: string }>(effectsOfKind(declined.effects, 'NightActionRejected')[0]).error
		).toBe('thief_must_take_wolf');

		const picked = reduce(initial, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'THIEF',
			action: { thiefPick: 'WOLF_KING' }
		});
		expect(picked.state.players[1].role).toBe('WOLF_KING');
	});
});

describe('M7: NIGHTMARE fear (§4.2, B49)', () => {
	it('a feared seat cannot act for the rest of that night or vote the next day; fear clears at the next night', () => {
		// The 恶灵骑士 is this board's only wolf: he first makes the pack's
		// kill in the WEREWOLF stage, then fears in his own.
		let { state } = start({ 1: 'NIGHTMARE', 2: 'SEER', 3: 'VILLAGER', 4: 'VILLAGER' });
		expect(state.currentStepKey).toBe('role:WEREWOLF');
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'NIGHTMARE',
			action: { wolfKillTarget: null } // 空刀 - nobody dies, so the day stays simple
		}));
		expect(state.submittedRoles).toEqual(['WEREWOLF']);
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		expect(state.currentStepKey).toBe('role:NIGHTMARE');

		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'NIGHTMARE',
			action: { nightmareFearTarget: 2 }
		}));
		expect(state.fearedSeat).toBe(2);

		({ state } = reduce(state, { type: 'ADVANCE_STAGE' })); // -> SEER
		expect(state.currentStepKey).toBe('role:SEER');

		// B49: the feared seer can't use their skill this same night.
		const rejected = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 2,
			role: 'SEER',
			action: { seerCheckTarget: 3 }
		});
		expect(
			payload<{ error: string }>(effectsOfKind(rejected.effects, 'NightActionRejected')[0]).error
		).toBe('feared');
		expect(rejected.state.nightActions.seerCheckTarget).toBeUndefined();

		// HUNTER not configured on this board - order exhausted -> DAWN.
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		({ state } = reduce(state, { type: 'ANNOUNCE_NIGHT_RESULTS' }));
		expect(state.phase).toBe('DISCUSSION'); // no deaths tonight
		({ state } = reduce(state, { type: 'BEGIN_VOTE' }));

		// The feared seat can't vote tomorrow either. Everyone else abstains -
		// nobody's eliminated, so the wolf (seat 1) survives into night 2,
		// which is what this test actually needs to check next.
		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 2, target: 1 }));
		expect(state.votes).toEqual({});
		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 3, target: 'ABSTAIN' }));
		({ state } = reduce(state, { type: 'CAST_VOTE', seat: 4, target: 'ABSTAIN' }));
		({ state } = reduce(state, { type: 'TALLY_VOTES' }));
		expect(state.phase).toBe('NIGHT');
		expect(state.round).toBe(2);
		// Fear clears at the start of the next night.
		expect(state.fearedSeat).toBeNull();

		// The seer can act normally again. Night 2 opens with the pack's kill
		// again (the 恶灵骑士 alone), then his own fear stage.
		expect(state.currentStepKey).toBe('role:WEREWOLF');
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'NIGHTMARE',
			action: { wolfKillTarget: null }
		}));
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		expect(state.currentStepKey).toBe('role:NIGHTMARE');
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'NIGHTMARE',
			action: { nightmareFearTarget: 3 }
		}));
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' })); // -> SEER
		const allowed = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 2,
			role: 'SEER',
			action: { seerCheckTarget: 4 }
		});
		expect(effectsOfKind(allowed.effects, 'NightActionRejected')).toEqual([]);
		expect(allowed.state.nightActions.seerCheckTarget).toBe(4);
	});
});

describe('EXILE (host records the table vote)', () => {
	it('a hunter exiled at day shoots, then the day waits for END_DAY', () => {
		const state = makeState(
			{ 1: 'HUNTER', 2: 'WEREWOLF', 3: 'WEREWOLF', 4: 'VILLAGER', 5: 'VILLAGER', 6: 'SEER' },
			{ phase: 'DISCUSSION', round: 1 }
		);
		const exiled = reduce(state, { type: 'EXILE', seat: 1 });
		expect(exiled.state.players[1].deathCause).toBe('VOTE_OUT');
		expect(exiled.state.phase).toBe('HUNTER_SHOOT');
		const resolved = payload(effectsOfKind(exiled.effects, 'DayResolved')[0]);
		expect(resolved).toMatchObject({ eliminatedSeat: 1, identity: null });

		const shot = reduce(exiled.state, { type: 'HUNTER_SHOOT', shooterSeat: 1, targetSeat: 2 });
		expect(shot.state.players[2].isDead).toBe(true);
		expect(shot.state.phase).toBe('DISCUSSION');
		expect(shot.state.dayDecided).toBe(true);
		// Only once per day.
		expect(reduce(shot.state, { type: 'EXILE', seat: 4 }).effects).toEqual([]);

		const night = reduce(shot.state, { type: 'END_DAY' }).state;
		expect(night.phase).toBe('NIGHT');
		expect(night.dayDecided).toBe(false);
	});

	it('an exiled lover takes their partner along (殉情)', () => {
		const state = makeState(
			{ 1: 'VILLAGER', 2: 'WEREWOLF', 3: 'WEREWOLF', 4: 'VILLAGER', 5: 'SEER' },
			{ phase: 'DISCUSSION', round: 1, lovers: [1, 4] }
		);
		const { state: after, effects } = reduce(state, { type: 'EXILE', seat: 1 });
		expect(after.players[4].deathCause).toBe('LOVER_SUICIDE');
		expect(payload(effectsOfKind(effects, 'DayResolved')[0])).toMatchObject({
			followDeathSeat: 4
		});
	});

	it("can't exile a dead or flipped seat", () => {
		const state = makeState(
			{ 1: 'IDIOT', 2: 'WEREWOLF', 3: 'VILLAGER' },
			{ phase: 'DISCUSSION', round: 1 }
		);
		state.players[1].isRevealedIdiot = true;
		state.players[3].isDead = true;
		expect(reduce(state, { type: 'EXILE', seat: 1 }).effects).toEqual([]);
		expect(reduce(state, { type: 'EXILE', seat: 3 }).effects).toEqual([]);
	});
});

describe('witch after the antidote is spent', () => {
	it('no longer learns who the wolves attacked', () => {
		let { state } = start({ 1: 'WEREWOLF', 2: 'SEER', 3: 'WITCH', 4: 'VILLAGER', 5: 'VILLAGER' });
		state = { ...state, witchAntidoteUsed: true };
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 4 }
		}));
		const advanced = reduce(state, { type: 'ADVANCE_STAGE' });
		state = advanced.state;
		const effects = advanced.effects;
		expect(state.currentStepKey).toBe('role:WITCH');
		const witchPrompt = payload(effectsOfKind(effects, 'YourTurnPrompt')[0]) as {
			context: { witch: { killedSeat: number | null; antidoteAvailable: boolean } };
		};
		expect(witchPrompt.context.witch.killedSeat).toBeNull();
		expect(witchPrompt.context.witch.antidoteAvailable).toBe(false);
	});
});

describe('night action guards', () => {
	it('gives the seer only one check per night, even on a double-tap', () => {
		let { state } = start({
			1: 'WEREWOLF',
			2: 'SEER',
			3: 'VILLAGER',
			4: 'VILLAGER',
			5: 'WEREWOLF'
		});
		state = { ...state, currentStepKey: 'role:SEER' };
		const check = (target: number) =>
			reduce(state, {
				type: 'SUBMIT_NIGHT_ACTION',
				seat: 2,
				role: 'SEER',
				action: { seerCheckTarget: target }
			});
		({ state } = check(1));
		const second = check(5);
		expect(effectsOfKind(second.effects, 'SeerResult')).toHaveLength(0);
		expect(payload(effectsOfKind(second.effects, 'NightActionRejected')[0])).toMatchObject({
			error: 'already_submitted'
		});
	});

	it('rejects a target that is already out', () => {
		let { state } = start({
			1: 'WEREWOLF',
			2: 'SEER',
			3: 'VILLAGER',
			4: 'VILLAGER',
			5: 'WEREWOLF'
		});
		state = kill(structuredClone(state), 3);
		const { state: after, effects } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 3 }
		});
		expect(payload(effectsOfKind(effects, 'NightActionRejected')[0])).toMatchObject({
			error: 'invalid_target'
		});
		expect(after.nightActions.wolfKillTarget).toBeUndefined();
	});

	it('rejects a night action from a dead player, even in their role’s 假环节', () => {
		let { state } = start({
			1: 'WEREWOLF',
			2: 'SEER',
			3: 'VILLAGER',
			4: 'VILLAGER',
			5: 'WEREWOLF'
		});
		state = { ...kill(structuredClone(state), 2), currentStepKey: 'role:SEER' };
		const { state: after, effects } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 2,
			role: 'SEER',
			action: { seerCheckTarget: 1 }
		});
		expect(effectsOfKind(effects, 'SeerResult')).toHaveLength(0);
		expect(payload(effectsOfKind(effects, 'NightActionRejected')[0])).toMatchObject({
			error: 'not_your_turn'
		});
		expect(after.submittedRoles).not.toContain('SEER');
	});
});

describe('a stage whose last holder is removed mid-turn (上帝之手)', () => {
	it('moves on to the next stage instead of starting the night over', () => {
		const state = makeState(
			{
				1: 'WEREWOLF',
				2: 'WOLF_BEAUTY',
				3: 'SEER',
				4: 'WITCH',
				5: 'VILLAGER',
				6: 'VILLAGER',
				7: 'VILLAGER'
			},
			{ phase: 'NIGHT', round: 2, currentStepKey: 'role:WOLF_BEAUTY' }
		);
		const before = reduce(state, { type: 'ADVANCE_STAGE' }).state.currentStepKey;
		const killed = reduce(state, { type: 'HOST_OVERRIDE', kind: 'KILL', seat: 2 }).state;
		expect(killed.currentStepKey).toBe('role:WOLF_BEAUTY');
		const after = reduce(killed, { type: 'ADVANCE_STAGE' }).state;
		expect(after.currentStepKey).toBe(before);
	});
});

describe('上帝之手 edge cases', () => {
	it('a seat revived at dawn is left out of the night announcement', () => {
		let { state } = start({
			1: 'WEREWOLF',
			2: 'SEER',
			3: 'VILLAGER',
			4: 'VILLAGER',
			5: 'WEREWOLF'
		});
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 3 }
		}));
		while (state.phase !== 'DAWN') ({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		({ state } = reduce(state, { type: 'HOST_OVERRIDE', kind: 'REVIVE', seat: 3 }));
		const { state: after, effects } = reduce(state, { type: 'ANNOUNCE_NIGHT_RESULTS' });
		const announced = payload(effectsOfKind(effects, 'NightResultsAnnounced')[0]) as {
			deaths: { seat: number }[];
		};
		expect(announced.deaths).toEqual([]);
		expect(after.players[3].isDead).toBe(false);
	});

	it('ignores overrides once the game is over', () => {
		let { state } = start({
			1: 'WEREWOLF',
			2: 'SEER',
			3: 'VILLAGER',
			4: 'VILLAGER',
			5: 'WEREWOLF'
		});
		({ state } = reduce(state, { type: 'HOST_OVERRIDE', kind: 'KILL', seat: 1 }));
		({ state } = reduce(state, { type: 'HOST_OVERRIDE', kind: 'KILL', seat: 5 }));
		expect(state.phase).toBe('GAME_OVER');
		const { effects } = reduce(state, { type: 'HOST_OVERRIDE', kind: 'REVIVE', seat: 1 });
		expect(effects).toHaveLength(0);
	});
});

describe('空刀 and self-picks', () => {
	it('offers 空刀 to the pack only when the room allows it, and accepts it', () => {
		const roles = {
			1: 'WEREWOLF',
			2: 'SEER',
			3: 'VILLAGER',
			4: 'VILLAGER',
			5: 'WOLF_BEAUTY'
		} as const;
		let { state } = start(roles);
		state = {
			...state,
			ruleConfig: { ...state.ruleConfig, wolf: { ...state.ruleConfig.wolf, allowEmptyKill: true } }
		};
		const prompts = effectsOfKind(notifyRoleHolders(state, 'WEREWOLF'), 'YourTurnPrompt');
		expect(prompts.length).toBe(2);
		for (const p of prompts)
			expect(
				(payload(p) as { context: { wolf?: { allowEmptyKill?: boolean } } }).context.wolf
			).toMatchObject({ allowEmptyKill: true });
		const r = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 5,
			role: 'WOLF_BEAUTY',
			action: { wolfKillTarget: null }
		});
		expect(effectsOfKind(r.effects, 'NightActionRejected')).toHaveLength(0);
		expect(r.state.nightActions.wolfKillTarget).toBeNull();

		const base = start(roles).state;
		const plain = {
			...base,
			ruleConfig: { ...base.ruleConfig, wolf: { ...base.ruleConfig.wolf, allowEmptyKill: false } }
		};
		const p0 = payload(
			effectsOfKind(notifyRoleHolders(plain, 'WEREWOLF'), 'YourTurnPrompt')[0]
		) as {
			context: { wolf?: { allowEmptyKill?: boolean } };
		};
		expect(p0.context.wolf?.allowEmptyKill).toBeUndefined();
	});

	it('refuses a 野孩子 picking themselves as idol', () => {
		let { state } = start({
			1: 'WEREWOLF',
			2: 'WILD_CHILD',
			3: 'VILLAGER',
			4: 'SEER',
			5: 'WEREWOLF'
		});
		state = { ...state, currentStepKey: 'role:WILD_CHILD' };
		const r = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 2,
			role: 'WILD_CHILD',
			action: { wildChildIdol: 2 }
		});
		expect(payload(effectsOfKind(r.effects, 'NightActionRejected')[0])).toMatchObject({
			error: 'invalid_target'
		});
	});
});

describe('空守 (guard.allowEmptyGuard)', () => {
	const board = { 1: 'WEREWOLF', 2: 'GUARD', 3: 'SEER', 4: 'VILLAGER', 5: 'VILLAGER' } as const;
	const guardNobody = (state: GameState) =>
		reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 2,
			role: 'GUARD',
			action: { guardTarget: null }
		});
	const allowing = (state: GameState): GameState => ({
		...state,
		ruleConfig: { ...state.ruleConfig, guard: { ...state.ruleConfig.guard, allowEmptyGuard: true } }
	});

	it('is refused by default - the guard must pick someone', () => {
		const { state } = start(board);
		const { state: after, effects } = guardNobody(state);
		const rejection = effectsOfKind(effects, 'NightActionRejected')[0];
		expect(payload(rejection).error).toBe('guard_empty_not_allowed');
		expect(after.nightActions.guardTarget).toBeUndefined();
	});

	it('when allowed, protects nobody and is offered on the turn prompt', () => {
		const { state } = start(board);
		const prompt = notifyRoleHolders(allowing(state), 'GUARD')[0];
		expect(payload<{ context: { guard: unknown } }>(prompt).context.guard).toEqual({
			lastProtectedSeat: null,
			allowEmptyGuard: true
		});
		const { state: after, effects } = guardNobody(allowing(state));
		expect(effectsOfKind(effects, 'NightActionRejected')).toHaveLength(0);
		expect(after.nightActions.guardTarget).toBeNull();
		expect(after.submittedRoles).toContain('GUARD');
	});

	it('a night of 空守 lets the guard protect last-guarded seat again', () => {
		const { state } = start(board);
		const s = { ...allowing(state), lastGuardTarget: 4 };
		const { state: after } = guardNobody(s);
		expect(after.lastGuardTarget).toBeNull();
	});
});

describe('what a phone that missed the moment can be told later', () => {
	it('a seer check is kept with its verdict, for the seat that made it', () => {
		const state = makeState(
			{ 1: 'WEREWOLF', 2: 'SEER', 3: 'VILLAGER' },
			{ phase: 'NIGHT', round: 2, currentStepKey: 'role:SEER' }
		);
		const { state: after } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 2,
			role: 'SEER',
			action: { seerCheckTarget: 1 }
		});
		expect(after.seerChecks).toEqual([{ round: 2, seat: 2, targetSeat: 1, isBad: true }]);
	});

	it('the last announcements are kept with the game', () => {
		const dawn = makeState(
			{ 1: 'WEREWOLF', 2: 'SEER', 3: 'VILLAGER', 4: 'VILLAGER', 5: 'WEREWOLF', 6: 'WITCH' },
			{ phase: 'DAWN', round: 1, pendingNightDeaths: [{ seat: 3, cause: 'WOLF_KILL' }] as never }
		);
		const { state: day } = reduce(dawn, { type: 'ANNOUNCE_NIGHT_RESULTS' });
		expect(day.announcedNightDeaths).toEqual([3]);
	});

	it('a fallen 猎人 is remembered with what they were told', () => {
		const state = makeState({ 1: 'HUNTER', 2: 'VILLAGER' });
		const effects: EngineEffect[] = [];
		const after = produce(state, (draft) => {
			pushShotStatus(draft, effects, [{ seat: 1, cause: 'WOLF_KILL' }] as never);
		});
		expect(after.shotStatuses).toEqual({ 1: false });
	});
});

describe('自爆 at dawn, before the night news (the table is electing a 警长)', () => {
	const dawn = (overrides: Partial<GameState> = {}) => {
		const state = makeState(
			{ 1: 'WEREWOLF', 2: 'WEREWOLF', 3: 'SEER', 4: 'VILLAGER', 5: 'VILLAGER', 6: 'WITCH' },
			{
				phase: 'DAWN',
				round: 1,
				pendingNightDeaths: [{ seat: 4, cause: 'WOLF_KILL' }],
				...overrides
			}
		);
		state.players[4].isDead = true;
		return state;
	};
	const told = (effects: EngineEffect[]) => JSON.stringify(effects.map((e) => e.payload));

	it('records the explosion and keeps the night news secret until 公布', () => {
		const { state, effects } = reduce(dawn(), { type: 'SELF_EXPLODE', seat: 1 });
		expect(state.phase).toBe('DAWN');
		expect(state.players[1].isDead).toBe(true);
		expect(state.dayDecided).toBe(true);
		expect(state.pendingNightDeaths).toEqual([{ seat: 4, cause: 'WOLF_KILL' }]);
		expect(effectsOfKind(effects, 'SelfExploded')).toHaveLength(1);
		expect(effectsOfKind(effects, 'NightResultsAnnounced')).toHaveLength(0);
		expect(told(effects)).not.toContain('"seat":4');
	});

	it('公布 then tells the news, and the day has only 进入下一夜 left', () => {
		const exploded = reduce(dawn(), { type: 'SELF_EXPLODE', seat: 1 }).state;
		const { state, effects } = reduce(exploded, { type: 'ANNOUNCE_NIGHT_RESULTS' });
		expect(
			payload<{ deaths: unknown }>(effectsOfKind(effects, 'NightResultsAnnounced')[0]).deaths
		).toEqual([{ seat: 4, cause: 'WOLF_KILL' }]);
		expect(state.phase).toBe('DISCUSSION');
		expect(state.dayDecided).toBe(true);
		expect(reduce(state, { type: 'BEGIN_VOTE' }).effects).toHaveLength(0);
		expect(reduce(state, { type: 'END_DAY' }).state.phase).toBe('NIGHT');
	});

	it('the last wolf exploding doesn’t end the game before the news is told', () => {
		const state = makeState(
			{ 1: 'WEREWOLF', 2: 'SEER', 3: 'VILLAGER', 4: 'VILLAGER' },
			{ phase: 'DAWN', round: 1, pendingNightDeaths: [] }
		);
		const exploded = reduce(state, { type: 'SELF_EXPLODE', seat: 1 });
		expect(exploded.state.phase).toBe('DAWN');
		expect(effectsOfKind(exploded.effects, 'GameOver')).toHaveLength(0);
		expect(reduce(exploded.state, { type: 'ANNOUNCE_NIGHT_RESULTS' }).state.phase).toBe(
			'GAME_OVER'
		);
	});

	it('a wolf killed last night can still explode, without giving that away', () => {
		const start = dawn({ pendingNightDeaths: [{ seat: 1, cause: 'WOLF_KILL' }] });
		start.players[4].isDead = false;
		start.players[1].isDead = true;
		const { state, effects } = reduce(start, { type: 'SELF_EXPLODE', seat: 1 });
		expect(effectsOfKind(effects, 'SelfExploded')).toHaveLength(1);
		expect(state.pendingNightDeaths).toEqual([]);
	});

	it('any seat the Host picks is accepted: a refusal would tell the Host it isn’t a wolf', () => {
		const { effects } = reduce(dawn(), { type: 'SELF_EXPLODE', seat: 3 });
		expect(effectsOfKind(effects, 'SelfExploded')).toHaveLength(1);
	});

	it('a second explosion the same dawn is ignored', () => {
		const exploded = reduce(dawn(), { type: 'SELF_EXPLODE', seat: 1 }).state;
		expect(reduce(exploded, { type: 'SELF_EXPLODE', seat: 2 }).effects).toHaveLength(0);
	});
});

/** Steps the night on until `done` holds - bounded, so a stage that never
 * comes fails the test instead of hanging it. */
function advanceUntil(state: GameState, done: (s: GameState) => boolean): GameState {
	for (let i = 0; i < 40 && !done(state); i++)
		({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
	if (!done(state)) throw new Error(`stuck at ${state.phase} ${state.currentStepKey}`);
	return state;
}
const toDawnOf = (state: GameState) => advanceUntil(state, (s) => s.phase === 'DAWN');
const toStageOf = (state: GameState, role: RoleId) =>
	advanceUntil(state, (s) => s.currentStepKey === `role:${role}`);
/** DAWN -> announce -> through 遗言 -> the next night. */
function nextNightOf(state: GameState): GameState {
	({ state } = reduce(state, { type: 'ANNOUNCE_NIGHT_RESULTS' }));
	for (let i = 0; i < 20 && state.phase === 'LAST_WORDS'; i++)
		({ state } = reduce(state, { type: 'NEXT_SPEAKER' }));
	({ state } = reduce(state, { type: 'END_DAY' }));
	return state;
}
const rejection = (effects: EngineEffect[]) =>
	effectsOfKind(effects, 'NightActionRejected').map((e) => payload<{ error: string }>(e).error);

describe('禁言长老', () => {
	const board = {
		1: 'WEREWOLF',
		2: 'VILLAGER',
		3: 'SILENCE_ELDER',
		4: 'VILLAGER',
		5: 'SEER'
	} as const;

	/** Plays the night up to the elder's turn, then has them silence `target`. */
	const silence = (state: GameState, target: number | null) =>
		reduce(toStageOf(state, 'SILENCE_ELDER'), {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 3,
			role: 'SILENCE_ELDER',
			action: { silenceTarget: target }
		});

	it('wakes on the first night too', () => {
		expect(silence(start(board).state, 2).state.nightActions.silenceTarget).toBe(2);
	});

	it('the silenced seat is announced with the night’s news, and only then', () => {
		const dawn = toDawnOf(silence(start(board).state, 4).state);
		expect(dawn.announcedSilenced).toBeUndefined();
		const announced = reduce(dawn, { type: 'ANNOUNCE_NIGHT_RESULTS' });
		const news = payload<{ silenced: number | null }>(
			effectsOfKind(announced.effects, 'NightResultsAnnounced')[0]
		);
		expect(news.silenced).toBe(4);
		expect(announced.state.announcedSilenced).toBe(4);
		// A new night forgets it.
		expect(nextNightOf(dawn).announcedSilenced).toBeUndefined();
	});

	it('a silenced seat who died in the night is not announced as silenced', () => {
		let { state } = start(board);
		state = toStageOf(state, 'WEREWOLF');
		({ state } = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 4 }
		}));
		const announced = reduce(toDawnOf(silence(state, 4).state), {
			type: 'ANNOUNCE_NIGHT_RESULTS'
		});
		const news = payload<{ silenced: number | null }>(
			effectsOfKind(announced.effects, 'NightResultsAnnounced')[0]
		);
		expect(news.silenced).toBeNull();
	});

	it('may silence themself or nobody, but not the same seat two nights running', () => {
		expect(silence(start(board).state, 3).state.nightActions.silenceTarget).toBe(3);

		const night2 = nextNightOf(toDawnOf(silence(start(board).state, 2).state));
		expect(rejection(silence(night2, 2).effects)).toEqual(['silence_repeat_target']);
		expect(silence(night2, 4).state.nightActions.silenceTarget).toBe(4);
		expect(silence(night2, null).state.submittedRoles).toContain('SILENCE_ELDER');

		// A night without a silence breaks the chain.
		const skipped = nextNightOf(toDawnOf(silence(night2, null).state));
		expect(silence(skipped, 2).state.nightActions.silenceTarget).toBe(2);
	});

	it('the elder’s prompt says whom they silenced last night', () => {
		const night2 = toStageOf(
			nextNightOf(toDawnOf(silence(start(board).state, 2).state)),
			'SILENCE_ELDER'
		);
		const ctx = payload<{ context: { silence: { lastSilencedSeat: number | null } } }>(
			notifyRoleHolders(night2, 'SILENCE_ELDER')[0]
		);
		expect(ctx.context.silence.lastSilencedSeat).toBe(2);
	});
});

describe('潜行者', () => {
	const board = {
		1: 'WEREWOLF',
		2: 'VILLAGER',
		3: 'STALKER',
		4: 'VILLAGER',
		5: 'HUNTER'
	} as const;

	const stalk = (state: GameState, target: number | null) =>
		reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 3,
			role: 'STALKER',
			action: { stalkerKillTarget: target }
		});
	const usedFlag = (state: GameState) =>
		payload<{ context: { stalker: { used: boolean } } }>(notifyRoleHolders(state, 'STALKER')[0])
			.context.stalker.used;

	it('has no turn on the first night (nobody has voted yet)', () => {
		let { state } = start(board);
		const order: (string | null)[] = [];
		for (let i = 0; i < 40 && state.phase !== 'DAWN'; i++) {
			order.push(state.currentStepKey);
			({ state } = reduce(state, { type: 'ADVANCE_STAGE' }));
		}
		expect(state.phase).toBe('DAWN');
		expect(order).not.toContain('role:STALKER');
	});

	it('kills once from night 2: the seat dies at dawn, and the skill is spent', () => {
		let state = toStageOf(nextNightOf(toDawnOf(start(board).state)), 'STALKER');
		expect(usedFlag(state)).toBe(false);
		({ state } = stalk(state, 2));
		expect(state.stalkerUsed).toBe(true);
		state = toDawnOf(state);
		expect(state.pendingNightDeaths).toEqual([{ seat: 2, cause: 'STALKER_KILL' }]);

		// Night 3: the turn still runs (its absence would give the role away),
		// but only a pass is accepted.
		state = toStageOf(nextNightOf(state), 'STALKER');
		expect(usedFlag(state)).toBe(true);
		expect(rejection(stalk(state, 4).effects)).toEqual(['stalker_used']);
		expect(stalk(state, null).state.submittedRoles).toContain('STALKER');
	});

	it('passing keeps the skill for a later night', () => {
		const state = toStageOf(nextNightOf(toDawnOf(start(board).state)), 'STALKER');
		const passed = stalk(state, null).state;
		expect(passed.stalkerUsed ?? false).toBe(false);
		expect(toDawnOf(passed).pendingNightDeaths).toEqual([]);
	});

	it('a hunter the stalker kills may still shoot', () => {
		const cfg = start(board).state;
		let state: GameState = { ...cfg, ruleConfig: { ...cfg.ruleConfig, shotsAtTable: true } };
		state = toStageOf(nextNightOf(toDawnOf(state)), 'STALKER');
		({ state } = stalk(state, 5));
		const announced = reduce(toDawnOf(state), { type: 'ANNOUNCE_NIGHT_RESULTS' });
		const status = effectsOfKind(announced.effects, 'ShotStatus');
		expect(status.map((e) => [e.seat, payload<{ canShoot: boolean }>(e).canShoot])).toEqual([
			[5, true]
		]);
	});
});
