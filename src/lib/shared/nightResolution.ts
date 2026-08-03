// Ported bit-for-bit from the original app's `resolve_night()` (server.py).
// The exact sequence below is order-dependent and intentional - see the
// "同守同救" comment. Do not "simplify" this into independent boolean rules
// without checking that quirk still holds.

export interface NightActionInputs {
	/** 普通狼人's kill target, or null if no kill was made/no wolves acted. */
	werewolfKillSeat: number | null;
	/** 女巫's poison target, or null if no poison was used. */
	witchPoisonSeat: number | null;
	/**
	 * The seat the witch's one-time antidote was used on, or null if not used.
	 * The witch can only ever save the werewolves' kill target - callers must
	 * set this to `werewolfKillSeat` when the antidote is used, never an
	 * arbitrary seat.
	 */
	witchAntidoteSeat: number | null;
	/** 守卫's protect target, or null if no protection was made/no guard in play. */
	guardProtectSeat: number | null;
	/** 狼美人's charm/link target for tonight, or null. */
	wolfBeautyTargetSeat: number | null;
	/** The seat holding 狼美人 itself, or null if not in play. */
	wolfBeautySeat: number | null;
	/** The two seats linked by 丘比特, or null if not in play / not yet linked. */
	coupleSeats: [number, number] | null;
}

/** Returns the sorted list of seat numbers that die this night. Pure, no I/O. */
export function resolveNightDeaths(input: NightActionInputs): number[] {
	const {
		werewolfKillSeat,
		witchPoisonSeat,
		witchAntidoteSeat,
		guardProtectSeat,
		wolfBeautyTargetSeat,
		wolfBeautySeat,
		coupleSeats
	} = input;

	const dieSet = new Set<number>();
	if (werewolfKillSeat) dieSet.add(werewolfKillSeat);
	if (witchPoisonSeat) dieSet.add(witchPoisonSeat);

	if (witchAntidoteSeat !== null && dieSet.has(witchAntidoteSeat)) {
		dieSet.delete(witchAntidoteSeat);
	}
	if (guardProtectSeat !== null && guardProtectSeat === werewolfKillSeat) {
		dieSet.delete(guardProtectSeat);
	}
	// "同守同救": if the guard protected the exact seat the witch also saved
	// with the antidote that same night, that seat dies anyway. Order-dependent
	// on the two rules above - preserved exactly as the original app computed
	// it, not "fixed".
	if (guardProtectSeat !== null && guardProtectSeat === witchAntidoteSeat) {
		dieSet.add(guardProtectSeat);
	}

	for (const seat of Array.from(dieSet)) {
		if (wolfBeautySeat !== null && seat === wolfBeautyTargetSeat) {
			dieSet.add(wolfBeautySeat);
		}
		if (coupleSeats && coupleSeats.includes(seat)) {
			dieSet.add(coupleSeats[0]);
			dieSet.add(coupleSeats[1]);
		}
	}

	return Array.from(dieSet).sort((a, b) => a - b);
}
