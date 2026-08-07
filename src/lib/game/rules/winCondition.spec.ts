import { describe, it, expect } from 'vitest';
import { checkWinCondition, getCamp, isCrossCampLovers, baseCamp } from './winCondition';
import { makeState, kill, defaultRuleConfig } from '../testFixtures';
import type { RuleConfig } from '../types';

const totalKillCfg: RuleConfig = { ...defaultRuleConfig(), winCondition: 'TOTAL_KILL' };

// ---------------------------------------------------------------------------
// Byte-for-byte parity with the old shared/winCondition.ts suite (checkWin +
// checkWinWithCouple), run under winCondition: 'TOTAL_KILL' - the config
// value that reproduces today's exact `wolves >= nonWolves` behavior. Every
// seat here starts alive (checkWin's old callers only ever passed the
// *living* roster).
// ---------------------------------------------------------------------------
describe('checkWinCondition - TOTAL_KILL (parity with old checkWin/checkWinWithCouple)', () => {
	it('no winner while both sides alive and wolves outnumbered', () => {
		const state = makeState(
			{ 1: 'WEREWOLF', 2: 'VILLAGER', 3: 'VILLAGER', 4: 'SEER' },
			{ ruleConfig: totalKillCfg }
		);
		expect(checkWinCondition(state)).toBeNull();
	});

	it('villagers (GOOD) win when zero wolves remain', () => {
		const state = makeState({ 1: 'VILLAGER', 2: 'SEER', 3: 'WITCH' }, { ruleConfig: totalKillCfg });
		expect(checkWinCondition(state)).toBe('GOOD');
	});

	it('villagers win (degenerate empty-room case) when nobody is left', () => {
		const state = makeState({}, { ruleConfig: totalKillCfg });
		expect(checkWinCondition(state)).toBe('GOOD');
	});

	it('wolves win when they equal the remaining villagers (>=, not just >)', () => {
		const state = makeState({ 1: 'WEREWOLF', 2: 'VILLAGER' }, { ruleConfig: totalKillCfg });
		expect(checkWinCondition(state)).toBe('WEREWOLF');
	});

	it('wolves win when they outnumber villagers', () => {
		const state = makeState(
			{ 1: 'WEREWOLF', 2: 'WEREWOLF', 3: 'VILLAGER' },
			{ ruleConfig: totalKillCfg }
		);
		expect(checkWinCondition(state)).toBe('WEREWOLF');
	});

	it('wolf-team special roles count toward the wolf side', () => {
		const state = makeState({ 1: 'WOLF_BEAUTY', 2: 'VILLAGER' }, { ruleConfig: totalKillCfg });
		expect(checkWinCondition(state)).toBe('WEREWOLF');
	});

	it('1-vs-1 endgame resolves immediately as a wolf win', () => {
		const state = makeState({ 1: 'WEREWOLF', 2: 'SEER' }, { ruleConfig: totalKillCfg });
		expect(checkWinCondition(state)).toBe('WEREWOLF');
	});

	it('with no couple in play, behaves exactly like the base tally', () => {
		const state = makeState({ 1: 'WEREWOLF', 2: 'VILLAGER' }, { ruleConfig: totalKillCfg });
		expect(checkWinCondition(state)).toBe('WEREWOLF');
	});

	it('a mixed-team couple is excluded from the tally, which still resolves around them', () => {
		const state = makeState(
			{ 1: 'WEREWOLF', 2: 'VILLAGER', 3: 'WEREWOLF', 4: 'VILLAGER' },
			{ ruleConfig: totalKillCfg, lovers: [1, 2] }
		);
		// Excluding the couple, the remaining roster is 1 wolf vs 1 non-wolf -> wolves win.
		expect(checkWinCondition(state)).toBe('WEREWOLF');
	});

	it('a mixed-team couple wins once every other seat is eliminated', () => {
		const state = makeState(
			{ 1: 'WEREWOLF', 2: 'VILLAGER' },
			{ ruleConfig: totalKillCfg, lovers: [1, 2] }
		);
		expect(checkWinCondition(state)).toBe('LOVERS');
	});

	it('a same-team (both wolf) couple is NOT third-party - counts toward the wolf side as normal', () => {
		const state = makeState(
			{ 1: 'WEREWOLF', 2: 'WEREWOLF', 3: 'VILLAGER' },
			{ ruleConfig: totalKillCfg, lovers: [1, 2] }
		);
		expect(checkWinCondition(state)).toBe('WEREWOLF');
	});

	it('a same-team (both village) couple is NOT third-party - no winner yet, matching two ordinary villagers', () => {
		const state = makeState(
			{ 1: 'VILLAGER', 2: 'SEER', 3: 'WEREWOLF' },
			{ ruleConfig: totalKillCfg, lovers: [1, 2] }
		);
		expect(checkWinCondition(state)).toBeNull();
	});

	it('丘比特 joins the third party: both lovers dead, Cupid alone still wins', () => {
		let state = makeState(
			{ 1: 'WEREWOLF', 2: 'SEER', 3: 'CUPID' },
			{ ruleConfig: totalKillCfg, lovers: [1, 2] }
		);
		state = kill(state, 1, 2);
		expect(checkWinCondition(state)).toBe('LOVERS');
	});

	it('丘比特 joins the third party: Cupid dead, both lovers alone still win', () => {
		let state = makeState(
			{ 1: 'WEREWOLF', 2: 'SEER', 3: 'CUPID' },
			{ ruleConfig: totalKillCfg, lovers: [1, 2] }
		);
		state = kill(state, 3);
		expect(checkWinCondition(state)).toBe('LOVERS');
	});

	it('the whole trio (both lovers + Cupid) dead resolves normally among survivors', () => {
		let state = makeState(
			{ 1: 'WEREWOLF', 2: 'VILLAGER', 3: 'CUPID', 4: 'VILLAGER' },
			{ ruleConfig: totalKillCfg, lovers: [1, 2] }
		);
		state = kill(state, 1, 2, 3);
		expect(checkWinCondition(state)).toBe('GOOD');
	});
});

// ---------------------------------------------------------------------------
// SIDE_KILL (屠边) - the spec's own default, adopted per the M0 plan's
// decision 2. Deliberately different from TOTAL_KILL: a side only needs to
// be wiped, not merely outnumbered.
// ---------------------------------------------------------------------------
describe('checkWinCondition - SIDE_KILL (new spec default)', () => {
	it('gods all dead but a villager survives -> wolves win (would NOT win yet under TOTAL_KILL)', () => {
		let state = makeState({ 1: 'WEREWOLF', 2: 'SEER', 3: 'VILLAGER', 4: 'VILLAGER' });
		state = kill(state, 2);
		expect(checkWinCondition(state)).toBe('WEREWOLF');
		expect(checkWinCondition({ ...state, ruleConfig: totalKillCfg })).toBeNull();
	});

	it('villagers all dead but gods survive -> wolves win', () => {
		let state = makeState({ 1: 'WEREWOLF', 2: 'SEER', 3: 'WITCH', 4: 'VILLAGER' });
		state = kill(state, 4);
		expect(checkWinCondition(state)).toBe('WEREWOLF');
	});

	it("a side never in play (no gods dealt) doesn't count as wiped", () => {
		const state = makeState({ 1: 'WEREWOLF', 2: 'VILLAGER', 3: 'VILLAGER' });
		expect(checkWinCondition(state)).toBeNull();
	});

	it('zero wolves still wins for GOOD under SIDE_KILL too (priority 2 beats priority 3)', () => {
		const state = makeState({ 1: 'VILLAGER', 2: 'SEER' });
		expect(checkWinCondition(state)).toBe('GOOD');
	});
});

describe('getCamp / isCrossCampLovers / baseCamp', () => {
	it('baseCamp ignores couple status entirely', () => {
		const state = makeState({ 1: 'WEREWOLF', 2: 'VILLAGER' }, { lovers: [1, 2] });
		expect(baseCamp(state.players[1])).toBe('WEREWOLF');
		expect(baseCamp(state.players[2])).toBe('GOOD');
	});

	it('isCrossCampLovers is true only for a mixed-camp couple', () => {
		const mixed = makeState({ 1: 'WEREWOLF', 2: 'VILLAGER' }, { lovers: [1, 2] });
		expect(isCrossCampLovers(mixed)).toBe(true);
		const sameTeam = makeState({ 1: 'VILLAGER', 2: 'SEER' }, { lovers: [1, 2] });
		expect(isCrossCampLovers(sameTeam)).toBe(false);
		const noCouple = makeState({ 1: 'WEREWOLF', 2: 'VILLAGER' });
		expect(isCrossCampLovers(noCouple)).toBe(false);
	});

	it('getCamp returns LOVERS for a cross-camp couple, and for the Cupid who linked them', () => {
		const state = makeState(
			{ 1: 'WEREWOLF', 2: 'VILLAGER', 3: 'CUPID' },
			{ lovers: [1, 2], cupidSeat: 3 }
		);
		expect(getCamp(state, 1)).toBe('LOVERS');
		expect(getCamp(state, 2)).toBe('LOVERS');
		expect(getCamp(state, 3)).toBe('LOVERS');
	});

	it('getCamp returns the base camp for everyone else, and for a same-camp couple', () => {
		const state = makeState({ 1: 'VILLAGER', 2: 'SEER', 3: 'WEREWOLF' }, { lovers: [1, 2] });
		expect(getCamp(state, 1)).toBe('GOOD');
		expect(getCamp(state, 2)).toBe('GOOD');
		expect(getCamp(state, 3)).toBe('WEREWOLF');
	});

	it('cupidJoinsLoversCamp = false keeps Cupid on their base camp even for a cross-camp link', () => {
		const cfg: RuleConfig = { ...defaultRuleConfig(), cupidJoinsLoversCamp: false };
		const state = makeState(
			{ 1: 'WEREWOLF', 2: 'VILLAGER', 3: 'CUPID' },
			{ ruleConfig: cfg, lovers: [1, 2], cupidSeat: 3 }
		);
		expect(getCamp(state, 3)).toBe('GOOD');
		// The lovers themselves are unaffected by this switch - it only gates Cupid.
		expect(getCamp(state, 1)).toBe('LOVERS');
	});
});
