import { describe, it, expect } from 'vitest';
import { resolveNightDeaths, type NightActionInputs } from './nightResolution';

const base: NightActionInputs = {
	werewolfKillSeat: null,
	witchPoisonSeat: null,
	witchAntidoteSeat: null,
	guardProtectSeat: null,
	wolfBeautyTargetSeat: null,
	wolfBeautySeat: null,
	coupleSeats: null
};

describe('resolveNightDeaths', () => {
	it('peaceful night: no kill, no poison -> nobody dies', () => {
		expect(resolveNightDeaths(base)).toEqual([]);
	});

	it('plain kill with no saves', () => {
		expect(resolveNightDeaths({ ...base, werewolfKillSeat: 3 })).toEqual([3]);
	});

	it('kill + separate poison -> both die', () => {
		expect(resolveNightDeaths({ ...base, werewolfKillSeat: 3, witchPoisonSeat: 5 })).toEqual([
			3, 5
		]);
	});

	it('antidote saves the kill target', () => {
		expect(resolveNightDeaths({ ...base, werewolfKillSeat: 3, witchAntidoteSeat: 3 })).toEqual([]);
	});

	it('antidote only ever applies to the kill target, poison is unaffected', () => {
		expect(
			resolveNightDeaths({
				...base,
				werewolfKillSeat: 3,
				witchAntidoteSeat: 3,
				witchPoisonSeat: 5
			})
		).toEqual([5]);
	});

	it('guard protects the kill target -> saved', () => {
		expect(resolveNightDeaths({ ...base, werewolfKillSeat: 3, guardProtectSeat: 3 })).toEqual([]);
	});

	it('guard protecting a seat that was not attacked has no effect', () => {
		expect(resolveNightDeaths({ ...base, werewolfKillSeat: 3, guardProtectSeat: 7 })).toEqual([3]);
	});

	it('同守同救: guard and witch save the exact same seat -> that seat dies anyway', () => {
		expect(
			resolveNightDeaths({
				...base,
				werewolfKillSeat: 3,
				witchAntidoteSeat: 3,
				guardProtectSeat: 3
			})
		).toEqual([3]);
	});

	it('guard and witch saving different seats both work independently', () => {
		// wolves kill 3, witch antidotes 3 (saved), guard protects 7 (not attacked, no-op)
		expect(
			resolveNightDeaths({
				...base,
				werewolfKillSeat: 3,
				witchAntidoteSeat: 3,
				guardProtectSeat: 7
			})
		).toEqual([]);
	});

	it('wolf-beauty link death: charmed target dies -> wolf beauty dies too', () => {
		expect(
			resolveNightDeaths({
				...base,
				werewolfKillSeat: 3,
				wolfBeautyTargetSeat: 3,
				wolfBeautySeat: 9
			})
		).toEqual([3, 9]);
	});

	it('wolf-beauty herself can be the direct kill target without double-adding', () => {
		expect(
			resolveNightDeaths({
				...base,
				werewolfKillSeat: 9,
				wolfBeautyTargetSeat: 3,
				wolfBeautySeat: 9
			})
		).toEqual([9]);
	});

	it('wolf-beauty link does not trigger if the charmed target survives', () => {
		expect(
			resolveNightDeaths({
				...base,
				werewolfKillSeat: 3,
				guardProtectSeat: 3,
				wolfBeautyTargetSeat: 3,
				wolfBeautySeat: 9
			})
		).toEqual([]);
	});

	it('cupid couple link: one half dying kills both', () => {
		expect(resolveNightDeaths({ ...base, werewolfKillSeat: 4, coupleSeats: [4, 8] })).toEqual([
			4, 8
		]);
	});

	it('cupid link triggers correctly when the FIRST half of the pair dies (regression: old app used a falsy indexOf check that silently skipped this case)', () => {
		expect(resolveNightDeaths({ ...base, werewolfKillSeat: 4, coupleSeats: [4, 8] })).toContain(8);
	});

	it('combined: kill+poison, one saved by antidote, wolf-beauty and couple links both fire', () => {
		// wolves kill seat 4 (linked to couple partner 8, and is the wolf-beauty charm target)
		// witch poisons seat 6, no antidote used
		expect(
			resolveNightDeaths({
				...base,
				werewolfKillSeat: 4,
				witchPoisonSeat: 6,
				wolfBeautyTargetSeat: 4,
				wolfBeautySeat: 9,
				coupleSeats: [4, 8]
			})
		).toEqual([4, 6, 8, 9]);
	});
});
