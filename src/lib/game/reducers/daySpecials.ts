// Day events outside the vote: the hunter's shot, a wolf's self-explosion
// and the knight's duel. Part of the engine (see engine.ts) - pure, no IO.

import type { Death, DeathCause, EngineAction, EngineResult, GameState, Seat } from '../types';
import { cascadeDeaths } from '../rules/nightResolution';
import { checkWinCondition, baseCamp } from '../rules/winCondition';
import { withEffects, endGame } from './core';
import { enterHunterShootOrContinue, lastWordsFrom, pushShotStatus } from './day';

// ---------------------------------------------------------------------------
// HUNTER_SHOOT - resolves whichever seat is at the head of pendingShoots
// (chain-shot: a second HUNTER_SHOOT while more remain in the queue prompts
// the next one instead of leaving the phase).
// ---------------------------------------------------------------------------

export function handleHunterShoot(
	state: GameState,
	action: Extract<EngineAction, { type: 'HUNTER_SHOOT' }>
): EngineResult {
	return withEffects(state, (draft, effects) => {
		if (draft.phase !== 'HUNTER_SHOOT') return;
		if (draft.pendingShoots[0] !== action.shooterSeat) return; // not this seat's turn
		draft.pendingShoots.shift();

		let followDeathSeat: Seat | null = null;
		let shotDeaths: Death[] = [];
		if (action.targetSeat !== null) {
			const shooter = draft.players[action.shooterSeat];
			const cause: DeathCause =
				shooter?.role === 'WOLF_KING' || shooter?.role === 'BLACK_WOLF_KING'
					? 'WOLF_KING_SHOT'
					: 'HUNTER_SHOT';
			shotDeaths = cascadeDeaths(draft, [{ seat: action.targetSeat, cause }], {
				ruleConfig: draft.ruleConfig
			});
			followDeathSeat = shotDeaths.find((d) => d.seat !== action.targetSeat)?.seat ?? null;
		}
		effects.push({
			kind: 'BROADCAST',
			payload: {
				kind: 'HunterResolved',
				hunterSeat: action.shooterSeat,
				shotSeat: action.targetSeat,
				followDeathSeat
			}
		});

		const whenDone = draft.returnPhase === 'NIGHT' ? 'NIGHT' : 'DISCUSSION';
		draft.returnPhase = null;
		const lastWordsSeats = lastWordsFrom(shotDeaths, draft.ruleConfig.lastWords.hunterShotVictim);
		enterHunterShootOrContinue(draft, effects, lastWordsSeats, whenDone);
	});
}

// ---------------------------------------------------------------------------
// SELF_EXPLODE / KNIGHT_DUEL - §9.6 (M3/M5). Both are host-initiated day
// events the spec places in DISCUSSION (§9.3), where the host's UI keeps
// [有玩家自爆]/[骑士决斗] buttons resident for the whole phase.
// ---------------------------------------------------------------------------

export function handleSelfExplode(
	state: GameState,
	action: Extract<EngineAction, { type: 'SELF_EXPLODE' }>
): EngineResult {
	return withEffects(state, (draft, effects) => {
		if (draft.phase !== 'DISCUSSION' || draft.dayDecided) return;
		const player = draft.players[action.seat];
		if (!player || player.isDead) return;
		// "必须是狼阵营，服务端校验" - baseCamp, not getCamp: a cross-camp-couple
		// wolf's DYNAMIC camp is 'LOVERS' (getCamp's third-party override), but
		// they're still mechanically a wolf and must still be allowed to
		// explode as one (same reasoning as KNIGHT_DUEL's targetIsWolf check
		// below - B31 requires this exact case to still count as a wolf).
		// baseCamp still correctly reflects an already-converted 野孩子 (M7) as
		// WEREWOLF too, so that case isn't lost either.
		if (baseCamp(player) !== 'WEREWOLF') return;

		const deaths = cascadeDeaths(draft, [{ seat: action.seat, cause: 'SELF_EXPLODE' }], {
			ruleConfig: draft.ruleConfig
		});
		effects.push({ kind: 'BROADCAST', payload: { kind: 'SelfExploded', seat: action.seat } });

		const lastWordsSeats = lastWordsFrom(deaths, draft.ruleConfig.wolf.selfExplodeHasLastWords);
		// selfExplodeEndsDay: no exile today. The day still waits for the
		// host's 进入下一夜 rather than dropping straight into night while the
		// table is still reacting. Goes through the shared tail so a queued
		// wolf-king shot gets its HUNTER_SHOOT detour first.
		if (draft.ruleConfig.wolf.selfExplodeEndsDay) {
			draft.dayDecided = true;
			effects.push({ kind: 'BROADCAST', payload: { kind: 'DayDecided' } });
		}
		enterHunterShootOrContinue(draft, effects, lastWordsSeats, 'DISCUSSION');
	});
}

export function handleKnightDuel(
	state: GameState,
	action: Extract<EngineAction, { type: 'KNIGHT_DUEL' }>
): EngineResult {
	return withEffects(state, (draft, effects) => {
		if (draft.phase !== 'DISCUSSION' || draft.dayDecided) return;
		if (draft.knightUsed) return; // knight.onceOnly - the spec's only configured value
		if (action.knightSeat === action.targetSeat) return; // canTargetSelf: false

		const knight = draft.players[action.knightSeat];
		const target = draft.players[action.targetSeat];
		if (!knight || knight.isDead || knight.role !== 'KNIGHT') return;
		if (!target || target.isDead) return;

		draft.knightUsed = true;
		// baseCamp, not getCamp - see SELF_EXPLODE's identical note above (B31).
		const targetIsWolf = baseCamp(target) === 'WEREWOLF';
		// "服务端翻开被决斗者身份" - the target's identity is always exposed by
		// the duel itself, win or lose for the knight.
		target.revealedRole = target.role;

		// Everyone the duel kills: its loser plus anyone the cascade drags
		// along (a lover, a 狼美人's charmed seat) - the phones only learn of
		// those through `deaths`. In the table flow a shooter among them fires at the
		// table, like any other day shot.
		const settle = (deaths: Death[], loser: Seat): Seat[] => {
			if (draft.ruleConfig.shotsAtTable) {
				pushShotStatus(
					draft,
					effects,
					deaths.filter((d) => d.seat !== loser)
				);
				draft.pendingShoots = [];
			}
			return deaths.map((d) => d.seat).sort((a, b) => a - b);
		};

		if (targetIsWolf) {
			const deaths = settle(
				cascadeDeaths(draft, [{ seat: action.targetSeat, cause: 'KNIGHT_DUEL' }], {
					ruleConfig: draft.ruleConfig
				}),
				action.targetSeat
			);
			effects.push({
				kind: 'BROADCAST',
				payload: {
					kind: 'KnightDuelResolved',
					knightSeat: action.knightSeat,
					targetSeat: action.targetSeat,
					targetWasWolf: true,
					deaths
				}
			});
			if (draft.ruleConfig.knight.duelEndsDayIfWolf) {
				// SPEC-GAP: no lastWords.* switch covers KNIGHT_DUEL - the duel
				// already publicly reveals the target's identity, unlike every
				// other last-words-eligible death cause. Like a self-explosion,
				// the day is over but waits for the host's 进入下一夜.
				draft.dayDecided = true;
				effects.push({ kind: 'BROADCAST', payload: { kind: 'DayDecided' } });
				enterHunterShootOrContinue(draft, effects, [], 'DISCUSSION');
				return;
			}
		} else {
			let deaths: Seat[] = [];
			if (draft.ruleConfig.knight.knightDiesIfGood) {
				deaths = settle(
					cascadeDeaths(draft, [{ seat: action.knightSeat, cause: 'KNIGHT_DUEL_FAIL' }], {
						ruleConfig: draft.ruleConfig
					}),
					action.knightSeat
				);
			} else {
				// House rule: the knight survives a failed duel - still exposed,
				// same as the always-revealed target above.
				knight.revealedRole = 'KNIGHT';
			}
			effects.push({
				kind: 'BROADCAST',
				payload: {
					kind: 'KnightDuelResolved',
					knightSeat: action.knightSeat,
					targetSeat: action.targetSeat,
					targetWasWolf: false,
					deaths
				}
			});
			// "白天继续，进入投票" - stays in DISCUSSION, no phase transition (the
			// day continues normally toward an eventual BEGIN_VOTE, same as if
			// nothing had happened).
		}

		const winner = checkWinCondition(draft);
		if (winner) endGame(draft, effects, winner);
	});
}
