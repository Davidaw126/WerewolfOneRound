// §5 板子配置. Setup derivation (buildSetup) landed in M0 for
// checkWinCondition's SIDE_KILL branch; validateSetup (E01-E10) and the 8
// preset boards (presets.ts) are M2 work.

import type { RoleId, Setup } from '../types';
import { ALL_ROLE_IDS, ROLE_META } from '../roleMeta';
import { deriveSeatCount } from './deal';

/** godCount/villagerCount only ever reflect the GOOD side's own composition
 * (wolf-team roles don't count toward either) - that's what checkWinCondition's
 * SIDE_KILL branch (hadGods/hadVillagers) needs. VILLAGER is the only
 * non-god GOOD role in the current 15-role roster, so villagerCount is just
 * its count; godCount sums every other GOOD-camp role. */
export function buildSetup(roleConfig: Partial<Record<RoleId, number>>): Setup {
	let godCount = 0;
	for (const id of ALL_ROLE_IDS) {
		if (id === 'VILLAGER') continue;
		if (ROLE_META[id].camp !== 'GOOD') continue;
		godCount += roleConfig[id] ?? 0;
	}
	return {
		roleConfig,
		numberOfSeats: deriveSeatCount(roleConfig),
		godCount,
		villagerCount: roleConfig.VILLAGER ?? 0
	};
}

// ---------------------------------------------------------------------------
// §5.2 validateSetup - E01-E10. Called twice by the IO shell (M1's room.ts):
// once at RoomSubmitConfig (playerCount = setup.numberOfSeats, since nobody's
// seated yet - this only ever meaningfully checks the ROLE COMPOSITION itself,
// E02-E09) and again at RoomStartGame (playerCount = actually-seated count -
// this is where E01 catches a real, previously-unvalidated gap: neither the
// old app nor M1's initial port ever confirmed every configured seat actually
// got a player before dealing).
// ---------------------------------------------------------------------------

export type ValidationCode =
	'E01' | 'E02' | 'E03' | 'E04' | 'E05' | 'E06' | 'E07' | 'E08' | 'E09' | 'E10';

export interface ValidationIssue {
	code: ValidationCode;
	message: string;
}

export interface ValidationResult {
	/** No blocking errors - `warnings` (E09 only) don't affect this. */
	ok: boolean;
	errors: ValidationIssue[];
	warnings: ValidationIssue[];
}

/** §5.2's own literal roster (预言家/女巫/猎人/守卫/白痴/骑士/丘比特/盗贼/
 * 野孩子/白狼王/狼美人) - SPEC-GAP: DREAM_WEAVER and NIGHTMARE aren't listed,
 * so they're taken at face value as NOT uniqueness-constrained, even though
 * every other special/god role is. Not "fixed" here since nothing in the
 * spec suggests this was accidental rather than intentional. */
const UNIQUE_ROLES: ReadonlySet<RoleId> = new Set([
	'SEER',
	'WITCH',
	'HUNTER',
	'GUARD',
	'IDIOT',
	'KNIGHT',
	'CUPID',
	'THIEF',
	'WILD_CHILD',
	'WOLF_KING',
	'WOLF_BEAUTY'
]);

function issue(code: ValidationCode, message: string): ValidationIssue {
	return { code, message };
}

export function validateSetup(setup: Setup, playerCount: number): ValidationResult {
	const errors: ValidationIssue[] = [];
	const warnings: ValidationIssue[] = [];
	const { roleConfig } = setup;

	// E01 角色总数必须等于玩家数
	if (setup.numberOfSeats !== playerCount) {
		errors.push(
			issue(
				'E01',
				`角色总数（${setup.numberOfSeats}）与玩家数（${playerCount}）不一致，请检查是否所有座位都已入座`
			)
		);
	}

	let wolfCount = 0;
	let goodCount = 0;
	for (const id of ALL_ROLE_IDS) {
		const count = roleConfig[id] ?? 0;
		if (count < 0) errors.push(issue('E05', `${ROLE_META[id].name} 数量不能为负数`));
		if (count > 1 && UNIQUE_ROLES.has(id)) {
			errors.push(issue('E05', `${ROLE_META[id].name} 是唯一角色，数量不能超过 1`));
		}
		if (ROLE_META[id].camp === 'WEREWOLF') wolfCount += count;
		else goodCount += count;
	}

	// E02 狼人阵营人数 >= 1
	if (wolfCount < 1) errors.push(issue('E02', '狼人阵营至少需要 1 人'));
	// E03 好人阵营人数 >= 1
	if (goodCount < 1) errors.push(issue('E03', '好人阵营至少需要 1 人'));
	// E04 狼人数 < 好人数（否则开局即结束）
	if (wolfCount >= 1 && goodCount >= 1 && wolfCount >= goodCount) {
		errors.push(issue('E04', '狼人数必须少于好人数，否则一开局狼人就已经获胜'));
	}

	// E06 若含 THIEF：额外底牌数 = 2，玩家数 = 角色数 - 2 - automatically
	// satisfied by deriveSeatCount/dealCards' own construction (always buries
	// exactly 2 cards whenever THIEF > 0); E05's THIEF <= 1 check above is the
	// only way this could otherwise be violated, so no separate runtime check
	// is meaningful here.

	// E07 若含 WILD_CHILD：场上存活玩家 >= 4
	if ((roleConfig.WILD_CHILD ?? 0) > 0 && playerCount < 4) {
		errors.push(issue('E07', '配置了野孩子时，玩家数至少需要 4 人'));
	}
	// E08 若含 CUPID：场上玩家 >= 6
	if ((roleConfig.CUPID ?? 0) > 0 && playerCount < 6) {
		errors.push(issue('E08', '配置了丘比特时，玩家数至少需要 6 人'));
	}

	// E09 若含 KNIGHT：不与 IDIOT 冲突（可共存，仅提示节奏偏快）- non-blocking
	// per the spec's own text ("可共存，仅提示"), unlike every other code here.
	if ((roleConfig.KNIGHT ?? 0) > 0 && (roleConfig.IDIOT ?? 0) > 0) {
		warnings.push(issue('E09', '骑士与白痴同时在场，节奏可能偏慢，请知悉'));
	}

	// E10 警长竞选开启时，玩家数 >= 6 - SPEC-GAP: deferred until M5 actually
	// implements sheriff election. sheriffEnabled currently has no UI toggle
	// and no functioning mechanic at all, so hard-gating every game below 6
	// players on it now would only block small test games for a feature that
	// does nothing yet - not enforced here until that changes.

	return { ok: errors.length === 0, errors, warnings };
}
