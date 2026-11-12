// §10 死亡结算引擎 - the most correctness-critical part of the spec. Ported
// from the spec's pseudocode (§10.2/§10.3/§10.4) onto this app's actual
// types, while preserving the "同守同救" quirk and the general shape of the
// previous src/lib/shared/nightResolution.ts (bit-for-bit port of the
// original app's resolver). That file's own warning still applies here:
// this sequence is order-dependent and intentional - do not "simplify" into
// independent boolean rules without re-checking every case in
// nightResolution.spec.ts (parity) and the new §18.1 UT-01..UT-09 cases.
//
// cascadeDeaths mutates its `state` argument in place (matching the spec's
// own mutating pseudocode) - in the real engine (M0 engine.ts) this always
// runs inside an immer `produce()` call, so the mutations become part of an
// immutable update. For unit tests, a plain GameState-shaped object works
// identically (mutation syntax doesn't care whether the object is a draft).

import type { Death, DeathCause, GameState, NightActions, RuleConfig, Seat } from '../types';

// ---------------------------------------------------------------------------
// §10.2 resolveNight - collects the night's PENDING deaths (before cascade).
// ---------------------------------------------------------------------------

/** The slice of GameState resolveNight actually needs - kept narrow so unit
 * tests don't have to construct a full GameState. */
export interface NightResolutionContext {
	lastDreamTarget: Seat | null;
}

// B50: 同一目标被多个来源致死 -> 死因取"限制最强"的那个。Spec only orders 4
// causes explicitly; DREAM_WEAVER can also collide here (poisoned AND
// two-nights-dreamed the same seat) but isn't in the spec's list - ranked
// below the four spec-ordered causes per §17 principle 2 (从严判定/strict
// judgment under ambiguity: keep whichever cause carries the stricter
// downstream consequence - WITCH_POISON blocks a hunter shot, the others
// listed here don't, so it stays on top regardless of what else collides).
// SPEC-GAP: DREAM_WEAVER's rank relative to the other three isn't specified.
const RESOLVE_NIGHT_SEVERITY: Partial<Record<DeathCause, number>> = {
	WITCH_POISON: 4,
	LOVER_SUICIDE: 3,
	WOLF_KILL: 2,
	VOTE_OUT: 1,
	DREAM_WEAVER: 0
};

function upsertDeath(pending: Death[], death: Death): void {
	const existing = pending.find((d) => d.seat === death.seat);
	if (!existing) {
		pending.push(death);
		return;
	}
	const existingSeverity = RESOLVE_NIGHT_SEVERITY[existing.cause] ?? -1;
	const newSeverity = RESOLVE_NIGHT_SEVERITY[death.cause] ?? -1;
	if (newSeverity > existingSeverity) existing.cause = death.cause;
}

/** Returns the night's pending deaths, in resolution order. Callers pass the
 * result into cascadeDeaths to apply follow-on triggers (殉情, etc.) and
 * commit them to state. */
export function resolveNight(
	cfg: RuleConfig,
	ctx: NightResolutionContext,
	a: NightActions
): Death[] {
	const pending: Death[] = [];

	// ---- Step 1: does the wolf kill land? ----
	if (a.wolfKillTarget != null) {
		const t = a.wolfKillTarget;
		const guarded = a.guardTarget === t;
		const antidoted = a.witchAntidoteTarget === t;
		const dreamProtected = a.dreamWeaverTarget === t;

		let survives: boolean;
		if (guarded && antidoted) {
			// 同守同救: order-dependent on the two checks below, preserved exactly
			// as the original resolver computed it, not "fixed".
			survives = cfg.guard.sameGuardSameSave === 'TARGET_LIVES';
		} else if (guarded || antidoted || dreamProtected) {
			survives = true;
		} else {
			survives = false;
		}
		if (!survives) pending.push({ seat: t, cause: 'WOLF_KILL' });
	}

	// ---- Step 2: witch poison (ignores guard/antidote unless configured otherwise) ----
	if (a.witchPoisonTarget != null) {
		const t = a.witchPoisonTarget;
		const immune = cfg.guard.protectsAgainstPoison && a.guardTarget === t;
		if (!immune) {
			upsertDeath(pending, { seat: t, cause: 'WITCH_POISON' });
		}
	}

	// ---- Step 3: dream weaver, two nights running on the same seat ----
	if (a.dreamWeaverTarget != null && ctx.lastDreamTarget === a.dreamWeaverTarget) {
		upsertDeath(pending, { seat: a.dreamWeaverTarget, cause: 'DREAM_WEAVER' });
	}

	return pending;
}

// ---------------------------------------------------------------------------
// §10.4 猎人开枪资格判定
// ---------------------------------------------------------------------------

/**
 * The verdict shown on a 确认开枪状态 stage (猎人 / 黑狼王): resolves the
 * night so far on a throwaway copy and asks canTriggerShoot about this
 * seat's own death, if any. Both status stages run after every other night
 * action, so this is exactly what dawn will decide - including the indirect
 * cases a poison-only check missed, e.g. dying of 殉情 because the lover was
 * killed, under a rule that denies the shot for that. Not dying tonight
 * means nothing blocks the shot, so that's a 👍.
 */
export function predictCanShootTonight(state: GameState, seat: Seat): boolean {
	// A plain copy: `state` is usually a live immer draft, and cascadeDeaths
	// mutates whatever it's given.
	const sim = JSON.parse(JSON.stringify(state)) as GameState;
	const pending = resolveNight(
		sim.ruleConfig,
		{ lastDreamTarget: sim.lastDreamTarget },
		sim.nightActions
	);
	const deaths = cascadeDeaths(sim, pending, { ruleConfig: sim.ruleConfig });
	const mine = deaths.find((d) => d.seat === seat);
	return mine ? canTriggerShoot(sim.ruleConfig, sim, mine) : true;
}

export function canTriggerShoot(cfg: RuleConfig, state: GameState, d: Death): boolean {
	const player = state.players[d.seat];
	if (!player) return false;
	const role = player.role;

	if (role === 'HUNTER') {
		switch (d.cause) {
			case 'WOLF_KILL':
				return cfg.hunter.canShootWhenWolfKilled;
			case 'VOTE_OUT':
				return cfg.hunter.canShootWhenExiled;
			case 'WITCH_POISON':
				return cfg.hunter.canShootWhenPoisoned;
			case 'LOVER_SUICIDE': {
				if (!cfg.hunter.canShootWhenLoverSuicide) return false;
				// cupidPoisonBlocksHunter layers a narrower denial on top: even
				// when lover-suicide generally allows a shot, specifically dying
				// because your linked partner was poisoned still denies it.
				if (cfg.cupidPoisonBlocksHunter) {
					const partner = getLoverPartner(state, d.seat);
					if (partner !== null && state.players[partner]?.deathCause === 'WITCH_POISON') {
						return false;
					}
				}
				return true;
			}
			case 'WOLF_BEAUTY_LINK':
				return false;
			case 'HUNTER_SHOT':
			case 'WOLF_KING_SHOT':
				return true; // chain-shot: still gets to fire back
			case 'KNIGHT_DUEL_FAIL':
				return false;
			case 'HOST_OVERRIDE':
				return false; // the host decides separately, out of band
			default:
				return false;
		}
	}
	if (role === 'BLACK_WOLF_KING') {
		// 黑狼王 takes one player with him when he falls to the wolf kill, a
		// vote, or a shot (chain-shot, like the hunter). Not when poisoned (the
		// classic counter) and not on his own self-explosion; 殉情 is a house
		// rule (wolf.blackWolfKingCanShootWhenLoverSuicide).
		if (d.cause === 'LOVER_SUICIDE') return cfg.wolf.blackWolfKingCanShootWhenLoverSuicide;
		return (
			d.cause === 'WOLF_KILL' ||
			d.cause === 'VOTE_OUT' ||
			d.cause === 'HUNTER_SHOT' ||
			d.cause === 'WOLF_KING_SHOT'
		);
	}
	if (role === 'WOLF_KING' && d.cause === 'SELF_EXPLODE') {
		return cfg.wolf.wolfKingExplodeCanShoot;
	}
	if (role === 'WOLF_KING' && (d.cause === 'VOTE_OUT' || d.cause === 'WOLF_KILL')) {
		return true; // rare (killed by their own team), but the spec allows it
	}
	return false;
}

// ---------------------------------------------------------------------------
// §10.3 cascadeDeaths - MUST run to reach a stable death set. Mutates
// `state` in place (see file header for why that's safe here).
// ---------------------------------------------------------------------------

const CASCADE_MAX_ITERATIONS = 20;

export class CascadeLoopError extends Error {
	constructor() {
		super('CASCADE_LOOP');
	}
}

export function getLoverPartner(state: GameState, seat: Seat): Seat | null {
	if (!state.lovers) return null;
	const [a, b] = state.lovers;
	if (a === seat) return b;
	if (b === seat) return a;
	return null;
}

function markDead(state: GameState, seat: Seat, cause: DeathCause): void {
	const player = state.players[seat];
	if (!player) return;
	player.isDead = true;
	player.deathCause = cause;
	player.deathRound = state.round;
}

/** §10.3's `isProtectedFrom` hook - referenced by the spec but never given a
 * concrete rule anywhere in the document (no P0-P2 role mechanic needs a
 * cascade-stage protection beyond what resolveNight's Step 1 already
 * resolves before entering the cascade at all). Always false for now.
 * SPEC-GAP: no defined behavior; reserved for a future house rule. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature kept for when a P0-P2 role actually needs this hook
function isProtectedFrom(_state: GameState, _death: Death): boolean {
	return false;
}

export interface CascadeOptions {
	ruleConfig: RuleConfig;
}

/**
 * Applies every death in `initial`, then follows the fixed-priority trigger
 * chain (殉情 / 狼美人链接 / 野孩子变狼 / 警徽流 / 猎人开枪资格) until the
 * queue drains, mutating `state` as it goes. Returns the full resolved list
 * in application order (for the timeline / DAWN announcement).
 */
export function cascadeDeaths(state: GameState, initial: Death[], opts: CascadeOptions): Death[] {
	const resolved: Death[] = [];
	const queue: Death[] = [...initial];
	let guardCount = 0;

	while (queue.length > 0) {
		if (++guardCount > CASCADE_MAX_ITERATIONS) throw new CascadeLoopError();
		const d = queue.shift()!;
		const player = state.players[d.seat];
		if (!player || player.isDead) continue; // already dead - dedup
		if (isProtectedFrom(state, d)) continue;

		markDead(state, d.seat, d.cause);
		resolved.push(d);

		// T1: 情侣殉情
		const partner = getLoverPartner(state, d.seat);
		if (partner != null && !state.players[partner]?.isDead) {
			queue.push({ seat: partner, cause: 'LOVER_SUICIDE' });
		}

		// T2: 狼美人链接死亡 - the CHARMED TARGET dying pulls 狼美人 down with
		// them, not the reverse. Ported exactly from the old app's
		// resolveNightDeaths (shared/nightResolution.ts), which only ever adds
		// wolfBeautySeat to the death set when wolfBeautyTargetSeat is the seat
		// that died.
		if (state.charmedSeat === d.seat) {
			const beauty = Object.values(state.players).find((p) => p.role === 'WOLF_BEAUTY');
			if (beauty && !beauty.isDead) {
				queue.push({ seat: beauty.seat, cause: 'WOLF_BEAUTY_LINK' });
			}
		}

		// T3: 野孩子榜样死亡 -> 变狼（非死亡，改阵营 - handled by the caller via
		// convertedToWolf, checked again by checkWinCondition/getCamp)
		if (state.wildChildIdol === d.seat && state.wildChildSeat != null) {
			const child = state.players[state.wildChildSeat];
			if (child && !child.isDead && !child.convertedToWolf) {
				child.convertedToWolf = true;
				// A real change of card, not just of the win count: from here
				// they wake with the pack and the wolves see them as one of
				// their own. They're told once the death is public (engine.ts).
				child.role = 'WEREWOLF';
			}
		}

		// T4: 警徽流 - blocking, handled by the IO shell (host picks transfer-or-tear)
		if (state.sheriffSeat === d.seat) {
			state.pendingBadgeTransfer = d.seat;
		}

		// T5: 猎人 / 白狼王开枪 - blocking, not resolved here
		if (canTriggerShoot(opts.ruleConfig, state, d)) {
			state.pendingShoots.push(d.seat);
		}
	}
	return resolved;
}

// ---------------------------------------------------------------------------
// Legacy bridge, ported from the old shared/nightResolution.ts, kept for the
// day-vote / hunter-shot follow-death path until M1's cutover replaces those
// call sites with cascadeDeaths directly. See coupleFollowDeath's own spec
// in the old file - unchanged behavior, just re-exported under the new
// module so callers migrate incrementally.
// ---------------------------------------------------------------------------

export function coupleFollowDeath(deadSeat: Seat, coupleSeats: [Seat, Seat] | null): Seat[] {
	if (coupleSeats && coupleSeats.includes(deadSeat)) {
		return [...coupleSeats].sort((x, y) => x - y);
	}
	return [deadSeat];
}
