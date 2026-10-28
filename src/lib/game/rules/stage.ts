// The night-stage module: every question about "which night turn is it, who
// holds it, and is it done". GameState persists only `currentStepKey` (a
// string); this is the one place that encodes and reads it. The engine, the
// IO shell's pacing timers, the turn-prompt replay and the public projection
// all ask here instead of parsing the key themselves.

import type { GameState, RoleId } from '../types';
import { actsInStage, PACK_KILL_ROLES, STATUS_STAGE_ROLES } from '../roleMeta';
import type { NightStage } from './nightOrder';

const ROLE_PREFIX = 'role:';
const COUPLE_REVEAL_KEY = 'couple_reveal';

export function stageKey(stage: NightStage): string {
	return stage.kind === 'ROLE_TURN' ? `${ROLE_PREFIX}${stage.role}` : COUPLE_REVEAL_KEY;
}

export function stageOfKey(key: string | null): NightStage | null {
	if (key === null) return null;
	if (key === COUPLE_REVEAL_KEY) return { kind: 'COUPLE_REVEAL' };
	return { kind: 'ROLE_TURN', role: key.slice(ROLE_PREFIX.length) as RoleId };
}

/** The night stage the game is on, or null between stages / outside a night. */
export function currentStage(state: GameState): NightStage | null {
	return stageOfKey(state.currentStepKey);
}

/** The role whose turn it is, or null (no stage, or 情侣相认). */
export function currentStageRole(state: GameState): RoleId | null {
	const stage = currentStage(state);
	return stage?.kind === 'ROLE_TURN' ? stage.role : null;
}

export function isNightPhase(state: GameState): boolean {
	return state.phase === 'FIRST_NIGHT' || state.phase === 'NIGHT';
}

/** Someone alive wakes for this role's turn. actsInStage, not role equality:
 * a lone surviving wolf king is the real holder of the WEREWOLF stage. */
export function roleHasLivingHolder(state: GameState, role: RoleId): boolean {
	return Object.values(state.players).some((p) => !p.isDead && actsInStage(role, p.role));
}

/** This role's turn has already been used tonight. The pack's kill is one
 * shared decision, recorded under whichever wolf made it. */
export function turnUsed(state: GameState, role: RoleId): boolean {
	if (role === 'WEREWOLF') return state.submittedRoles.some((r) => PACK_KILL_ROLES.has(r));
	return state.submittedRoles.includes(role);
}

/** Whether everyone the current stage waits on has tapped 确认 - every living
 * holder on a 开枪状态 stage (a 上帝之手 second 猎人 included), every living
 * lover on 情侣相认. */
export function stageConfirmComplete(state: GameState): boolean {
	const stage = currentStage(state);
	const confirms = state.stageConfirms ?? [];
	if (!stage) return false;
	if (stage.kind === 'COUPLE_REVEAL') {
		const lovers = (state.lovers ?? []).filter((s) => !state.players[s]?.isDead);
		return lovers.length > 0 && lovers.every((s) => confirms.includes(s));
	}
	const holders = Object.values(state.players).filter(
		(p) => !p.isDead && actsInStage(stage.role, p.role)
	);
	return holders.length > 0 && holders.every((p) => confirms.includes(p.seat));
}

/** The current stage got everything it waits for (a submission, or every
 * 确认) and only the pause before the next turn is left. */
export function stageFinished(state: GameState): boolean {
	const stage = currentStage(state);
	if (!stage) return false;
	if (stage.kind === 'COUPLE_REVEAL' || STATUS_STAGE_ROLES.has(stage.role)) {
		return stageConfirmComplete(state);
	}
	return turnUsed(state, stage.role);
}
