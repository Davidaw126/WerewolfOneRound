// Ported from src/lib/server/game/turnContext.ts's notifyRoleHolders, with
// the same SECURITY invariant: everything built here is only ever meant to
// reach the one seat it's built for (a 'PRIVATE' EngineEffect, kind='PRIVATE'
// with an explicit `seat`) - the wolf teammate list in particular would hand
// the entire wolf team to the village if it ever went out as a 'BROADCAST'
// effect instead. The IO shell (M1) MUST preserve that distinction when
// turning effects into actual socket emits.

import type { EngineEffect, GameState, RoleId, Seat } from '../types';
import { predictCanShootTonight } from './nightResolution';
import { actsInStage } from '../roleMeta';

/**
 * Everything the acting player needs that only the server knows, delivered
 * privately with their turn prompt (YourTurnPrompt) - what a physical host
 * would say to that one player with everyone else's eyes shut. The one
 * definition: the engine builds it, the wire carries it, the phone reads it.
 *
 * NEVER broadcast. The wolf teammate list above all, but also the witch's
 * kill readout and the hunter's verdict, would expose hidden information.
 */
export interface TurnContext {
	/** The recipient's own seat. */
	seat: Seat;
	witch?: {
		/** Tonight's pack target, or null if nobody was attacked - also null
		 * once her antidote is spent (she no longer learns the kill). */
		killedSeat: Seat | null;
		/** Still unspent for the whole game. Whether it's usable right now
		 * also depends on the two verdicts below, which the server re-checks
		 * on submit. */
		antidoteAvailable: boolean;
		poisonAvailable: boolean;
		/** Tonight's verdicts for the room's RuleConfig.witch switches, so the
		 * panel offers what the server will accept. */
		selfRescueAllowed: boolean;
		bothPotionsSameNight: boolean;
	};
	/** 猎人 / 黑狼王 status turn: the same verdict the server will apply if
	 * they die tonight - a physical host's thumbs up or down. */
	hunter?: { canShoot: boolean };
	/** allowEmptyGuard: only when the room allows 空守. */
	guard?: { lastProtectedSeat: Seat | null; allowEmptyGuard?: boolean };
	/** Living wolf-team seats other than the recipient's own. allowEmptyKill:
	 * only on the pack's kill turn, when the room allows 空刀. */
	wolf?: { teammateSeats: Seat[]; allowEmptyKill?: boolean };
	/** 禁言长老: last night's pick, which can't be picked again tonight. */
	silence?: { lastSilencedSeat: Seat | null };
	/** 潜行者: whether their one kill is already spent. */
	stalker?: { used: boolean };
	/** 恶灵骑士 feared this seat tonight: no skill, the prompt only offers a
	 * pass (NightPass) so the turn can still end. */
	feared?: boolean;
	/** The pack's kill turn - a 狼美人/恶灵骑士 prompted now picks the kill
	 * with the other wolves, not their own skill (that comes in their own
	 * stage). */
	packKill?: boolean;
}

// Matches ROLE_META's visibleTeammates lists exactly (NIGHTMARE included,
// even though it's not `implemented` yet - harmless now since nightOrder.ts
// never builds NIGHTMARE a turn to reach this function with, and keeps this
// set from silently drifting out of sync again once M7 lands it).
const WOLF_TEAM_TURN_ROLES: ReadonlySet<RoleId> = new Set([
	'WEREWOLF',
	'WOLF_KING',
	'BLACK_WOLF_KING',
	'WOLF_BEAUTY',
	'NIGHTMARE'
]);

/**
 * Wakes every living holder of `role` and returns the private effects
 * their turn needs - the app standing in for what a physical host would say
 * aloud to that player alone. This is the single place any turn context is
 * computed.
 */
export function notifyRoleHolders(state: GameState, role: RoleId): EngineEffect[] {
	const effects: EngineEffect[] = [];

	// The witch needs to know who the wolves killed tonight to decide whether
	// to use the antidote - but only while she still has it. Once it's spent
	// she no longer learns the kill (standard rule).
	const killedSeat = state.witchAntidoteUsed ? null : (state.nightActions.wolfKillTarget ?? null);

	// Living wolf-team seats, for the wolves' own eyes only.
	let wolfSeats: Seat[] = [];
	if (WOLF_TEAM_TURN_ROLES.has(role)) {
		wolfSeats = Object.values(state.players)
			.filter((p) => !p.isDead && WOLF_TEAM_TURN_ROLES.has(p.role))
			.map((p) => p.seat)
			.sort((a, b) => a - b);
	}

	// WOLF_KING has no night stage of its own - it shares WEREWOLF's (see
	// roleMeta.ts) - so the WEREWOLF stage must wake WOLF_KING holders too.
	const matchesStage = (playerRole: RoleId): boolean => actsInStage(role, playerRole);

	for (const player of Object.values(state.players)) {
		if (player.isDead) continue;
		if (!matchesStage(player.role)) continue;

		// Each player's prompt is tagged with THEIR OWN role, not necessarily
		// the stage's nominal `role` - a WOLF_KING holder sees 'WOLF_KING' here
		// (matching what they'll submit back with, and what they were actually
		// dealt), even though the stage itself is keyed 'WEREWOLF'.
		const promptRole = player.role;
		const context: TurnContext = { seat: player.seat };
		if (role === 'WEREWOLF') context.packKill = true;
		// Not on 黑狼王's status stage: confirming his shot isn't a skill use,
		// and a pass there would be read as the pack's kill submission.
		if (
			state.fearedSeat === player.seat &&
			player.role !== 'NIGHTMARE' &&
			role !== 'BLACK_WOLF_KING'
		)
			context.feared = true;
		if (role === 'WITCH') {
			context.witch = {
				killedSeat,
				antidoteAvailable: !state.witchAntidoteUsed,
				poisonAvailable: !state.witchPoisonUsed,
				// Same verdicts nightRules.ts's validateWitchAction applies on submit.
				selfRescueAllowed:
					state.ruleConfig.witch.selfRescue === 'ALWAYS' ||
					(state.ruleConfig.witch.selfRescue === 'FIRST_NIGHT_ONLY' && state.isFirstNight),
				bothPotionsSameNight: state.ruleConfig.witch.bothPotionsSameNight
			};
		}
		// 确认开枪状态 (猎人 / 黑狼王): both stages run after every other night
		// action (see ROLE_META.nightOrder), so the verdict is final. 黑狼王
		// reuses the `hunter` field - the prompt renders the same thumbs.
		if (role === 'HUNTER' || role === 'BLACK_WOLF_KING') {
			context.hunter = { canShoot: predictCanShootTonight(state, player.seat) };
		}
		if (role === 'SILENCE_ELDER')
			context.silence = { lastSilencedSeat: state.lastSilenceTarget ?? null };
		if (role === 'STALKER') context.stalker = { used: state.stalkerUsed === true };
		if (role === 'GUARD') {
			context.guard = { lastProtectedSeat: state.lastGuardTarget };
			if (state.ruleConfig.guard.allowEmptyGuard) context.guard.allowEmptyGuard = true;
		}
		if (WOLF_TEAM_TURN_ROLES.has(role) && role !== 'BLACK_WOLF_KING') {
			context.wolf = { teammateSeats: wolfSeats.filter((s) => s !== player.seat) };
			if (role === 'WEREWOLF' && state.ruleConfig.wolf.allowEmptyKill)
				context.wolf.allowEmptyKill = true;
		}

		effects.push({
			kind: 'PRIVATE',
			seat: player.seat,
			payload: { kind: 'YourTurnPrompt', role: promptRole, context }
		});
		if (role === 'THIEF') {
			// Spread, not a bare reference: `player` is a live draft proxy here
			// (see the SECURITY note at the top of this file for why that's
			// fine internally) - but this array is about to leave the draft
			// tree via `effects`, and immer revokes every proxy it created once
			// the producer call returns. A shallow spread is enough since the
			// elements are plain RoleId strings, not nested objects.
			effects.push({
				kind: 'PRIVATE',
				seat: player.seat,
				payload: {
					kind: 'ThiefChoice',
					buried: player.thiefExtraCards ? [...player.thiefExtraCards] : []
				}
			});
		}
	}

	return effects;
}
