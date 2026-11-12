// Picking seats on the seat circle itself, instead of on a second grid of
// buttons under it. A panel that wants seat taps (a night prompt, the Host's
// 出局 marking, dawn 自爆, 上帝之手) claims the circle with its own rules -
// which seats can be tapped, which are picked, what a tap does - and releases
// it when it goes away. The rules and the draft stay with the panel; the
// circle only draws them. The newest claim wins, so the Host opening 上帝之手
// over their own night turn borrows the circle and gives it back on close.

import { untrack } from 'svelte';

export type PickTone = 'ember' | 'wolf';

export interface SeatPicking {
	/** May this seat be tapped now? */
	pickable(seat: number): boolean;
	/** How a picked seat is lit, or null when it isn't picked. */
	picked(seat: number): PickTone | null;
	tap(seat: number): void;
}

class SeatPick {
	private claims = $state<SeatPicking[]>([]);

	/** The panel currently picking on the circle, if any. */
	get current(): SeatPicking | null {
		return this.claims.at(-1) ?? null;
	}

	/** Claims the circle; call the returned function to release it. Called
	 * from a panel's $effect: the list is read untracked, or the effect would
	 * depend on the very list it writes and run forever. */
	claim(picking: SeatPicking): () => void {
		untrack(() => (this.claims = [...this.claims, picking]));
		return () => {
			untrack(() => (this.claims = this.claims.filter((c) => c !== picking)));
		};
	}
}

export const seatPick = new SeatPick();
