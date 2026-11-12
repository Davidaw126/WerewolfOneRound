// The Host's strip of tonight's turns: which are done, which is on now,
// which are still to come. Built only from the board's composition (public
// from the setup screen) and the stage the Host's phone is already told about
// (hostStage) - never from who is alive. A turn the night skips is simply
// passed over, which the table hears anyway: its narration never plays.

import type { RoleId } from '$lib/game/types';
import { buildNight1Order, buildRepeatingOrder, type NightStage } from '$lib/game/rules/nightOrder';

export type PlanStatus = 'done' | 'now' | 'next';

export interface PlanStep {
	stage: NightStage;
	status: PlanStatus;
}

const sameStage = (a: NightStage, b: NightStage) =>
	a.kind === b.kind && (a.kind === 'COUPLE_REVEAL' || a.role === (b as typeof a).role);

/** Tonight's turns for this board, each marked done / now / next. With no
 * current stage (dawn, or between nights) every turn is done. */
export function nightPlan(
	roleConfig: Partial<Record<RoleId, number>>,
	nightNumber: number,
	current: NightStage | null
): PlanStep[] {
	const onBoard = new Set(
		(Object.keys(roleConfig) as RoleId[]).filter((r) => (roleConfig[r] ?? 0) > 0)
	);
	const stages =
		nightNumber <= 1 ? buildNight1Order(roleConfig) : buildRepeatingOrder(onBoard, roleConfig);
	const at = current ? stages.findIndex((s) => sameStage(s, current)) : stages.length;
	return stages.map((stage, i) => ({
		stage,
		status: at < 0 ? 'next' : i < at ? 'done' : i === at ? 'now' : 'next'
	}));
}
