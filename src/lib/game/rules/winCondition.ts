// §11 胜负判定 - ported from the spec's pseudocode onto this app's types.
// `cfg` in the spec's own code is treated as ambiently available; here it's
// always `state.ruleConfig`, so every function stays a pure `(state, ...)`
// read with no hidden module-level config.
//
// The LOVERS/Cupid-trio behavior here is a direct port of what this app
// already shipped and live-tested (checkWinWithCouple in the old
// shared/winCondition.ts): a Cupid-linked cross-team couple forms an
// independent faction, and Cupid themselves joins it once the link is
// cross-team (win condition B20/B24/B25) - including winning alone after
// both lovers have died, since isCrossCampLovers only depends on the two
// linked seats' BASE camps, never their alive/dead status.

import type { Camp, GameState, Player, RoleId, Seat } from '../types';
import { ROLE_META } from '../roleMeta';

/** A player's camp with no couple/Cupid influence - only the (rare) 野孩子
 * conversion, which is a real permanent role change, not a couple effect.
 * isCrossCampLovers uses this specifically to avoid depending on getCamp
 * (which itself calls isCrossCampLovers - baseCamp breaks that cycle). */
export function baseCamp(player: Player): Camp {
	if (player.role === 'WILD_CHILD' && player.convertedToWolf) return 'WEREWOLF';
	return ROLE_META[player.role].camp;
}

export function isCrossCampLovers(state: GameState): boolean {
	if (!state.lovers) return false;
	const [a, b] = state.lovers;
	const playerA = state.players[a];
	const playerB = state.players[b];
	if (!playerA || !playerB) return false;
	return baseCamp(playerA) !== baseCamp(playerB);
}

/** §11.1 - MUST be computed dynamically, never cached on the player record:
 * a cross-team couple, Cupid joining them, and 野孩子 conversion can all
 * change a seat's effective camp mid-game. */
export function getCamp(state: GameState, seat: Seat): Camp {
	const p = state.players[seat];
	if (!p) throw new Error(`getCamp: no player at seat ${seat}`);
	const cfg = state.ruleConfig;

	// 1. 情侣第三方优先级最高
	if (state.lovers && state.lovers.includes(seat) && isCrossCampLovers(state)) {
		return 'LOVERS';
	}
	// 2. 丘比特：连成跨阵营情侣时加入情侣阵营
	if (p.role === 'CUPID' && cfg.cupidJoinsLoversCamp && isCrossCampLovers(state)) {
		return 'LOVERS';
	}
	// 3 & 4: 野孩子变狼 / 盗贼取牌后的实际身份 - both covered by baseCamp.
	return baseCamp(p);
}

function alivePlayers(state: GameState): Player[] {
	return Object.values(state.players).filter((p) => !p.isDead);
}

/** §11.2 - call after every death event (night resolution, day-vote
 * elimination, hunter revenge-shot), not just once per cycle. */
export function checkWinCondition(state: GameState): Camp | null {
	const cfg = state.ruleConfig;
	const alive = alivePlayers(state);
	const loversCamp = alive.filter((p) => getCamp(state, p.seat) === 'LOVERS');
	const wolves = alive.filter((p) => getCamp(state, p.seat) === 'WEREWOLF');
	const goods = alive.filter((p) => getCamp(state, p.seat) === 'GOOD');

	// --- Priority 1: 情侣阵营 ---
	// Every survivor belongs to the lovers camp -> lovers win (Cupid included).
	// If the lovers camp is wiped out entirely, the game just continues under
	// the normal camp check below - it does not count as a loss for anyone.
	if (loversCamp.length > 0 && loversCamp.length === alive.length) {
		return 'LOVERS';
	}

	// --- Priority 2: 好人胜 ---
	if (wolves.length === 0) return 'GOOD';

	// --- Priority 3: 狼人胜 ---
	if (cfg.winCondition === 'SIDE_KILL') {
		const aliveGods = goods.filter((p) => ROLE_META[p.role].isGod);
		const aliveVillagers = goods.filter((p) => !ROLE_META[p.role].isGod);
		// 屠边：神全死 或 民全死 - only counts a side as "must be wiped" if that
		// side was actually in play at all (setup.godCount/villagerCount > 0).
		const hadGods = state.setup.godCount > 0;
		const hadVillagers = state.setup.villagerCount > 0;
		if ((hadGods && aliveGods.length === 0) || (hadVillagers && aliveVillagers.length === 0)) {
			return 'WEREWOLF';
		}
	} else {
		if (goods.length === 0) return 'WEREWOLF';
	}

	// --- Priority 4: 狼人数 >= 好人数（无法翻盘）--- only under TOTAL_KILL;
	// this is what reproduces today's exact `wolves >= nonWolves` behavior.
	if (cfg.winCondition === 'TOTAL_KILL' && wolves.length >= goods.length) {
		return 'WEREWOLF';
	}

	return null;
}

/** Convenience for setup validation / RoleConfig UI - not part of the spec's
 * own pseudocode, but needed to derive Setup.godCount/villagerCount. */
export function isGodRole(id: RoleId): boolean {
	return ROLE_META[id].isGod;
}
