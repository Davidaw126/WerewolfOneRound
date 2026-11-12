// Who is picking on the seat circle: the newest claim, until it lets go.
import { describe, it, expect } from 'vitest';
import { seatPick, type SeatPicking } from './seatPick.svelte';

const picker = (name: string): SeatPicking & { name: string } => ({
	name,
	pickable: () => true,
	picked: () => null,
	tap: () => {}
});

describe('seat picking', () => {
	it('the newest claim picks; releasing it hands the circle back', () => {
		expect(seatPick.current).toBe(null);
		const night = picker('night');
		const god = picker('上帝之手');
		const releaseNight = seatPick.claim(night);
		const releaseGod = seatPick.claim(god);
		expect(seatPick.current).toBe(god);
		releaseGod();
		expect(seatPick.current).toBe(night);
		releaseNight();
		expect(seatPick.current).toBe(null);
	});

	it('an older claim letting go first leaves the newer one picking', () => {
		const a = picker('a');
		const b = picker('b');
		const releaseA = seatPick.claim(a);
		const releaseB = seatPick.claim(b);
		releaseA();
		expect(seatPick.current).toBe(b);
		releaseB();
		expect(seatPick.current).toBe(null);
	});
});
