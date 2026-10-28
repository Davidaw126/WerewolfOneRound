// 上帝之手: the Host's manual KILL / REVIVE / SET_ROLE, any time a game runs.
// Part of the engine (see engine.ts) - pure, no IO.

import type { EngineAction, EngineResult, GameState, Seat } from '../types';
import { currentStageRole, isNightPhase } from '../rules/stage';
import { notifyRoleHolders } from '../rules/turnContext';
import { cascadeDeaths } from '../rules/nightResolution';
import { checkWinCondition } from '../rules/winCondition';
import { actsInStage } from '../roleMeta';
import { withEffects, endGame } from './core';
import { pushShotStatus } from './day';

// ---------------------------------------------------------------------------
// HOST_OVERRIDE - 上帝之手 (§10.5). Minimal M0 plumbing so the type/action
// exists end to end; the actual override UI panel is M6 work.
// ---------------------------------------------------------------------------

export function handleHostOverride(
	state: GameState,
	action: Extract<EngineAction, { type: 'HOST_OVERRIDE' }>
): EngineResult {
	return withEffects(state, (draft, effects) => {
		const player = draft.players[action.seat];
		if (!player) return;
		// The game is decided - an override now would only end it a second time.
		if (draft.phase === 'GAME_OVER') return;
		draft.hostOverrideCount += 1;

		let deaths: Seat[] = [];
		if (action.kind === 'KILL') {
			if (!player.isDead) {
				const killed = cascadeDeaths(draft, [{ seat: action.seat, cause: 'HOST_OVERRIDE' }], {
					ruleConfig: draft.ruleConfig
				});
				// A lover dragged along may be a shooter: same table-flow
				// handling as DAY_OUT, so no stale pendingShoots survives to
				// pull a later END_DAY into HUNTER_SHOOT.
				if (draft.ruleConfig.shotsAtTable) {
					pushShotStatus(
						draft,
						effects,
						killed.filter((d) => d.seat !== action.seat)
					);
					draft.pendingShoots = [];
				}
				deaths = killed.map((d) => d.seat).sort((a, b) => a - b);
			}
		} else if (action.kind === 'REVIVE') {
			player.isDead = false;
			player.deathCause = undefined;
			player.deathRound = undefined;
			// Revived at DAWN, before 公布夜晚结果: off tonight's death list too,
			// or the announcement still reads them out (and every phone marks
			// them dead again). Nor do they still owe a shot.
			if (draft.pendingNightDeaths)
				draft.pendingNightDeaths = draft.pendingNightDeaths.filter((d) => d.seat !== action.seat);
			draft.pendingShoots = draft.pendingShoots.filter((s) => s !== action.seat);
		} else if (action.kind === 'SET_ROLE' && action.role) {
			player.role = action.role;
			// Their phone has to learn the new card - it used to keep showing
			// the old one.
			effects.push({
				kind: 'PRIVATE',
				seat: action.seat,
				payload: { kind: 'YourRole', role: action.role }
			});
			// Mid-night: if the new role's turn is happening right now (and
			// hasn't been used yet), wake them for it. A turn already past
			// tonight is simply missed; later stages pick the new role up on
			// their own, since the stage order is recomputed each step.
			const stageRole = isNightPhase(draft) ? currentStageRole(draft) : null;
			if (stageRole) {
				if (
					!player.isDead &&
					actsInStage(stageRole, action.role) &&
					!draft.submittedRoles.includes(stageRole)
				) {
					effects.push(
						...notifyRoleHolders(draft, stageRole).filter((e) => e.seat === action.seat)
					);
				}
			}
		}

		effects.push({
			kind: 'BROADCAST',
			payload: {
				kind: 'HostOverrideApplied',
				seat: action.seat,
				overrideKind: action.kind,
				deaths
			}
		});

		const winner = checkWinCondition(draft);
		if (winner) endGame(draft, effects, winner);
	});
}
