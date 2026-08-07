import { describe, it, expect } from 'vitest';
import {
	resolveNight,
	cascadeDeaths,
	predictHunterCanShoot,
	canTriggerShoot,
	getLoverPartner,
	type NightResolutionContext
} from './nightResolution';
import { makeState, defaultRuleConfig } from '../testFixtures';
import type { GameState, NightActions, RuleConfig } from '../types';

const emptyCtx: NightResolutionContext = { lastDreamTarget: null };

/** Runs the full §10.2 -> §10.3 pipeline (mirrors what engine.ts's
 * resolveNightPhase does at the end of a night) and returns both the
 * resolved deaths (in application order) and the mutated state so tests can
 * assert on `players[].isDead` too. */
function resolveFullNight(
	roles: Parameters<typeof makeState>[0],
	actions: NightActions,
	overrides: Partial<GameState> = {},
	ctx: NightResolutionContext = emptyCtx
) {
	const state = makeState(roles, overrides);
	const pending = resolveNight(state.ruleConfig, ctx, actions);
	const resolved = cascadeDeaths(state, pending, { ruleConfig: state.ruleConfig });
	return { resolved, state };
}

describe('resolveNight + cascadeDeaths (parity with the old shared/nightResolution.ts suite)', () => {
	it('peaceful night: no kill, no poison -> nobody dies', () => {
		const { resolved } = resolveFullNight({ 1: 'VILLAGER', 2: 'WEREWOLF' }, {});
		expect(resolved).toEqual([]);
	});

	it('plain kill with no saves', () => {
		const { resolved } = resolveFullNight({ 3: 'VILLAGER', 9: 'WEREWOLF' }, { wolfKillTarget: 3 });
		expect(resolved).toEqual([{ seat: 3, cause: 'WOLF_KILL' }]);
	});

	it('kill + separate poison -> both die', () => {
		const { resolved } = resolveFullNight(
			{ 3: 'VILLAGER', 5: 'VILLAGER', 9: 'WEREWOLF' },
			{ wolfKillTarget: 3, witchPoisonTarget: 5 }
		);
		expect(resolved.map((d) => d.seat).sort()).toEqual([3, 5]);
	});

	it('antidote saves the kill target', () => {
		const { resolved } = resolveFullNight(
			{ 3: 'VILLAGER', 9: 'WEREWOLF' },
			{ wolfKillTarget: 3, witchAntidoteTarget: 3 }
		);
		expect(resolved).toEqual([]);
	});

	it('antidote only ever applies to the kill target, poison is unaffected', () => {
		const { resolved } = resolveFullNight(
			{ 3: 'VILLAGER', 5: 'VILLAGER', 9: 'WEREWOLF' },
			{ wolfKillTarget: 3, witchAntidoteTarget: 3, witchPoisonTarget: 5 }
		);
		expect(resolved).toEqual([{ seat: 5, cause: 'WITCH_POISON' }]);
	});

	it('guard protects the kill target -> saved', () => {
		const { resolved } = resolveFullNight(
			{ 3: 'VILLAGER', 9: 'WEREWOLF' },
			{ wolfKillTarget: 3, guardTarget: 3 }
		);
		expect(resolved).toEqual([]);
	});

	it('guard protecting a seat that was not attacked has no effect', () => {
		const { resolved } = resolveFullNight(
			{ 3: 'VILLAGER', 7: 'VILLAGER', 9: 'WEREWOLF' },
			{ wolfKillTarget: 3, guardTarget: 7 }
		);
		expect(resolved).toEqual([{ seat: 3, cause: 'WOLF_KILL' }]);
	});

	it('同守同救 (default TARGET_DIES): guard and witch save the exact same seat -> dies anyway', () => {
		const { resolved } = resolveFullNight(
			{ 3: 'VILLAGER', 9: 'WEREWOLF' },
			{ wolfKillTarget: 3, witchAntidoteTarget: 3, guardTarget: 3 }
		);
		expect(resolved).toEqual([{ seat: 3, cause: 'WOLF_KILL' }]);
	});

	it('guard.sameGuardSameSave = TARGET_LIVES house rule: same seat saved twice survives', () => {
		const cfg: RuleConfig = {
			...defaultRuleConfig(),
			guard: { ...defaultRuleConfig().guard, sameGuardSameSave: 'TARGET_LIVES' }
		};
		const { resolved } = resolveFullNight(
			{ 3: 'VILLAGER', 9: 'WEREWOLF' },
			{ wolfKillTarget: 3, witchAntidoteTarget: 3, guardTarget: 3 },
			{ ruleConfig: cfg }
		);
		expect(resolved).toEqual([]);
	});

	it('guard and witch saving different seats both work independently', () => {
		const { resolved } = resolveFullNight(
			{ 3: 'VILLAGER', 7: 'VILLAGER', 9: 'WEREWOLF' },
			{ wolfKillTarget: 3, witchAntidoteTarget: 3, guardTarget: 7 }
		);
		expect(resolved).toEqual([]);
	});

	it('wolf-beauty link death: charmed target dies -> wolf beauty dies too (WOLF_BEAUTY_LINK)', () => {
		const { resolved } = resolveFullNight(
			{ 3: 'VILLAGER', 9: 'WOLF_BEAUTY' },
			{ wolfKillTarget: 3 },
			{ charmedSeat: 3 }
		);
		expect(resolved).toEqual([
			{ seat: 3, cause: 'WOLF_KILL' },
			{ seat: 9, cause: 'WOLF_BEAUTY_LINK' }
		]);
	});

	it('wolf-beauty herself can be the direct kill target without double-adding', () => {
		const { resolved } = resolveFullNight(
			{ 3: 'VILLAGER', 9: 'WOLF_BEAUTY' },
			{ wolfKillTarget: 9 },
			{ charmedSeat: 3 }
		);
		expect(resolved).toEqual([{ seat: 9, cause: 'WOLF_KILL' }]);
	});

	it('wolf-beauty link does not trigger if the charmed target survives', () => {
		const { resolved } = resolveFullNight(
			{ 3: 'VILLAGER', 9: 'WOLF_BEAUTY' },
			{ wolfKillTarget: 3, guardTarget: 3 },
			{ charmedSeat: 3 }
		);
		expect(resolved).toEqual([]);
	});

	it('couple link: one half dying kills both (LOVER_SUICIDE)', () => {
		const { resolved } = resolveFullNight(
			{ 4: 'VILLAGER', 8: 'VILLAGER', 9: 'WEREWOLF' },
			{ wolfKillTarget: 4 },
			{ lovers: [4, 8] }
		);
		expect(resolved).toEqual([
			{ seat: 4, cause: 'WOLF_KILL' },
			{ seat: 8, cause: 'LOVER_SUICIDE' }
		]);
	});

	it('couple link triggers when either half dies (order-independent)', () => {
		const { resolved } = resolveFullNight(
			{ 4: 'VILLAGER', 8: 'VILLAGER', 9: 'WEREWOLF' },
			{ wolfKillTarget: 8 },
			{ lovers: [4, 8] }
		);
		expect(resolved.map((d) => d.seat).sort()).toEqual([4, 8]);
	});

	it('combined: kill+poison, wolf-beauty and couple links both fire', () => {
		const { resolved } = resolveFullNight(
			{ 4: 'VILLAGER', 6: 'VILLAGER', 8: 'VILLAGER', 9: 'WOLF_BEAUTY' },
			{ wolfKillTarget: 4, witchPoisonTarget: 6 },
			{ charmedSeat: 4, lovers: [4, 8] }
		);
		expect(resolved.map((d) => d.seat).sort()).toEqual([4, 6, 8, 9]);
	});

	it('B50/upsertDeath severity: witch poison + wolf kill on the same seat keeps WITCH_POISON (stricter cause)', () => {
		const { resolved } = resolveFullNight(
			{ 3: 'VILLAGER', 9: 'WEREWOLF' },
			{ wolfKillTarget: 3, witchPoisonTarget: 3 }
		);
		expect(resolved).toEqual([{ seat: 3, cause: 'WITCH_POISON' }]);
	});

	it('dream weaver: same target two nights running dies (DREAM_WEAVER)', () => {
		const { resolved } = resolveFullNight(
			{ 5: 'VILLAGER' },
			{ dreamWeaverTarget: 5 },
			{},
			{ lastDreamTarget: 5 }
		);
		expect(resolved).toEqual([{ seat: 5, cause: 'DREAM_WEAVER' }]);
	});

	it('dream weaver: a different target than last night does not die', () => {
		const { resolved } = resolveFullNight(
			{ 5: 'VILLAGER' },
			{ dreamWeaverTarget: 5 },
			{},
			{ lastDreamTarget: 6 }
		);
		expect(resolved).toEqual([]);
	});
});

describe('cascadeDeaths death-cause mutation', () => {
	it('marks the player dead with the right cause and round', () => {
		const state = makeState({ 3: 'VILLAGER', 9: 'WEREWOLF' }, { round: 4 });
		cascadeDeaths(state, [{ seat: 3, cause: 'WOLF_KILL' }], { ruleConfig: state.ruleConfig });
		expect(state.players[3].isDead).toBe(true);
		expect(state.players[3].deathCause).toBe('WOLF_KILL');
		expect(state.players[3].deathRound).toBe(4);
	});

	it('an already-dead seat is not re-applied (dedup)', () => {
		const state = makeState({ 3: 'VILLAGER' });
		state.players[3].isDead = true;
		state.players[3].deathCause = 'VOTE_OUT';
		const resolved = cascadeDeaths(state, [{ seat: 3, cause: 'WOLF_KILL' }], {
			ruleConfig: state.ruleConfig
		});
		expect(resolved).toEqual([]);
		expect(state.players[3].deathCause).toBe('VOTE_OUT'); // unchanged
	});

	it('queues a hunter for a shot when they die from an eligible cause (T5)', () => {
		const state = makeState({ 3: 'HUNTER', 9: 'WEREWOLF' });
		cascadeDeaths(state, [{ seat: 3, cause: 'WOLF_KILL' }], { ruleConfig: state.ruleConfig });
		expect(state.pendingShoots).toEqual([3]);
	});

	it('does not queue a hunter poisoned to death (canShootWhenPoisoned default false)', () => {
		const state = makeState({ 3: 'HUNTER' });
		cascadeDeaths(state, [{ seat: 3, cause: 'WITCH_POISON' }], { ruleConfig: state.ruleConfig });
		expect(state.pendingShoots).toEqual([]);
	});
});

describe('getLoverPartner', () => {
	it('returns the other half of the couple', () => {
		const state = makeState({ 4: 'VILLAGER', 8: 'VILLAGER' }, { lovers: [4, 8] });
		expect(getLoverPartner(state, 4)).toBe(8);
		expect(getLoverPartner(state, 8)).toBe(4);
	});

	it('returns null when no couple is linked, or the seat is not in it', () => {
		const state = makeState({ 4: 'VILLAGER', 5: 'VILLAGER', 8: 'VILLAGER' }, { lovers: [4, 8] });
		expect(getLoverPartner(state, 5)).toBeNull();
		const noCouple = makeState({ 4: 'VILLAGER' });
		expect(getLoverPartner(noCouple, 4)).toBeNull();
	});
});

describe('predictHunterCanShoot (live turn-time prediction, before anyone has died)', () => {
	it('no poison used at all -> can shoot', () => {
		const state = makeState({ 1: 'HUNTER' });
		expect(predictHunterCanShoot(state.ruleConfig, state, 1, null)).toBe(true);
	});

	it('someone else was poisoned -> can still shoot', () => {
		const state = makeState({ 1: 'HUNTER', 4: 'VILLAGER' });
		expect(predictHunterCanShoot(state.ruleConfig, state, 1, 4)).toBe(true);
	});

	it('the hunter themself was poisoned -> denied', () => {
		const state = makeState({ 1: 'HUNTER' });
		expect(predictHunterCanShoot(state.ruleConfig, state, 1, 1)).toBe(false);
	});

	it('partner poisoned + cupidPoisonBlocksHunter on -> denied', () => {
		const cfg: RuleConfig = { ...defaultRuleConfig(), cupidPoisonBlocksHunter: true };
		const state = makeState({ 1: 'HUNTER', 4: 'VILLAGER' }, { ruleConfig: cfg, lovers: [1, 4] });
		expect(predictHunterCanShoot(state.ruleConfig, state, 1, 4)).toBe(false);
	});

	it('partner poisoned but the house rule is off -> can shoot', () => {
		const state = makeState({ 1: 'HUNTER', 4: 'VILLAGER' }, { lovers: [1, 4] });
		expect(predictHunterCanShoot(state.ruleConfig, state, 1, 4)).toBe(true);
	});

	it('house rule on but the hunter is not in the couple -> can shoot', () => {
		const cfg: RuleConfig = { ...defaultRuleConfig(), cupidPoisonBlocksHunter: true };
		const state = makeState(
			{ 1: 'HUNTER', 2: 'VILLAGER', 4: 'VILLAGER' },
			{ ruleConfig: cfg, lovers: [2, 4] }
		);
		expect(predictHunterCanShoot(state.ruleConfig, state, 1, 4)).toBe(true);
	});
});

describe('canTriggerShoot (post-death eligibility, §10.4)', () => {
	it('hunter wolf-killed -> eligible by default', () => {
		const state = makeState({ 1: 'HUNTER' });
		expect(canTriggerShoot(state.ruleConfig, state, { seat: 1, cause: 'WOLF_KILL' })).toBe(true);
	});

	it('hunter poisoned -> denied by default', () => {
		const state = makeState({ 1: 'HUNTER' });
		expect(canTriggerShoot(state.ruleConfig, state, { seat: 1, cause: 'WITCH_POISON' })).toBe(
			false
		);
	});

	it('hunter exiled by vote -> eligible by default', () => {
		const state = makeState({ 1: 'HUNTER' });
		expect(canTriggerShoot(state.ruleConfig, state, { seat: 1, cause: 'VOTE_OUT' })).toBe(true);
	});

	it('hunter died via wolf-beauty link -> never eligible', () => {
		const state = makeState({ 1: 'HUNTER' });
		expect(canTriggerShoot(state.ruleConfig, state, { seat: 1, cause: 'WOLF_BEAUTY_LINK' })).toBe(
			false
		);
	});

	it('a non-hunter, non-wolf-king role is never eligible', () => {
		const state = makeState({ 1: 'VILLAGER' });
		expect(canTriggerShoot(state.ruleConfig, state, { seat: 1, cause: 'WOLF_KILL' })).toBe(false);
	});

	it('lover-suicide hunter whose partner died to poison, with cupidPoisonBlocksHunter on -> denied', () => {
		const cfg: RuleConfig = { ...defaultRuleConfig(), cupidPoisonBlocksHunter: true };
		const state = makeState({ 1: 'HUNTER', 4: 'VILLAGER' }, { ruleConfig: cfg, lovers: [1, 4] });
		state.players[4].isDead = true;
		state.players[4].deathCause = 'WITCH_POISON';
		expect(canTriggerShoot(cfg, state, { seat: 1, cause: 'LOVER_SUICIDE' })).toBe(false);
	});
});
