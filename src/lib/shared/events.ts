import { z } from 'zod';
import { ALL_ROLES, type Role } from './roles';
import type { Phase, NightStage, PublicNightStage, RoomPublicState, Winner } from './gameTypes';

// ---------------------------------------------------------------------------
// Client -> server. One socket event name ('client:action') carries all of
// these as a discriminated union, validated server-side by the matching zod
// schema before anything touches Redis. Every handler acks with {ok, error?}
// instead of firing blind, so the UI can show inline validation errors.
// ---------------------------------------------------------------------------

const roleEnum = z.enum(ALL_ROLES as unknown as [Role, ...Role[]]);

// M2's RuleConfig switches (§6) exposed on the room-config screen - only the
// subset called for by the M2 milestone (winCondition + the wolf/guard/witch/
// hunter/idiot groups); the rest (sheriff/day-phase, timeouts, seer/cupid/
// thief/wildChild) stay at their engine defaults until the milestone that
// actually uses them (M5, mostly) adds a UI for them. Every field optional -
// an absent field just means "use the default".
export const RuleConfigOverridesSchema = z
	.object({
		winCondition: z.enum(['SIDE_KILL', 'TOTAL_KILL']),
		wolf: z.object({ allowEmptyKill: z.boolean() }).partial(),
		guard: z.object({ sameGuardSameSave: z.enum(['TARGET_DIES', 'TARGET_LIVES']) }).partial(),
		witch: z
			.object({
				selfRescue: z.enum(['FIRST_NIGHT_ONLY', 'NEVER', 'ALWAYS']),
				canPoisonSelf: z.boolean(),
				bothPotionsSameNight: z.boolean()
			})
			.partial(),
		hunter: z
			.object({
				canShootWhenPoisoned: z.boolean(),
				canShootWhenExiled: z.boolean(),
				canShootWhenWolfKilled: z.boolean(),
				canShootWhenLoverSuicide: z.boolean()
			})
			.partial(),
		idiot: z
			.object({
				revealOnExile: z.boolean(),
				keepsSpeechRight: z.boolean(),
				losesVoteRight: z.boolean(),
				canRunForSheriffAfterReveal: z.boolean(),
				tearsBadgeIfSheriff: z.boolean(),
				diesNormallyAtNight: z.boolean()
			})
			.partial()
	})
	.partial();
export type RuleConfigOverrides = z.infer<typeof RuleConfigOverridesSchema>;

export const NightActionSubmissionSchema = z.discriminatedUnion('role', [
	// nullable (空刀/empty kill) - the engine's own wolf.allowEmptyKill switch
	// (M2, default true) decides whether a null target is actually accepted;
	// this schema only gates the *shape*, same split as 女巫's poisonTarget.
	z.object({ role: z.literal('普通狼人'), targetSeat: z.number().int().positive().nullable() }),
	// 白狼王 (M3) shares 普通狼人's collective kill decision - same shape, same
	// nullable target - it has no separate night action of its own (see
	// roleMeta.ts's WOLF_KING.nightOrder comment).
	z.object({ role: z.literal('白狼王'), targetSeat: z.number().int().positive().nullable() }),
	z.object({ role: z.literal('预言家'), targetSeat: z.number().int().positive() }),
	z.object({
		role: z.literal('女巫'),
		poisonTarget: z.number().int().positive().nullable(),
		useAntidote: z.boolean()
	}),
	z.object({ role: z.literal('守卫'), targetSeat: z.number().int().positive() }),
	z.object({ role: z.literal('狼美人'), targetSeat: z.number().int().positive() }),
	z.object({
		role: z.literal('丘比特'),
		seatA: z.number().int().positive(),
		seatB: z.number().int().positive()
	}),
	z.object({ role: z.literal('盗贼'), swap: z.enum(['buried1', 'buried2']).nullable() }),
	// M7
	z.object({ role: z.literal('野孩子'), targetSeat: z.number().int().positive() }),
	z.object({ role: z.literal('摄梦人'), targetSeat: z.number().int().positive() }),
	z.object({ role: z.literal('恶灵骑士'), targetSeat: z.number().int().positive() })
]);
export type NightActionSubmission = z.infer<typeof NightActionSubmissionSchema>;

export const ClientActionSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('RoomCreate') }),
	z.object({ kind: z.literal('RoomJoin'), roomCode: z.string().regex(/^\d{6}$/) }),
	z.object({
		kind: z.literal('RoomSubmitConfig'),
		roleConfig: z.record(roleEnum, z.number().int().min(0)),
		cupidPoisonBlocksHunter: z.boolean(),
		ruleOverrides: RuleConfigOverridesSchema.optional()
	}),
	z.object({ kind: z.literal('RoomStartGame') }),
	z.object({ kind: z.literal('RoomLockSeats'), locked: z.boolean() }),
	z.object({ kind: z.literal('SeatTake'), seatNumber: z.number().int().positive() }),
	z.object({ kind: z.literal('RevealRole') }),
	z.object({ kind: z.literal('RoomRerollRoles') }),
	z.object({ kind: z.literal('RoomLeave') }),
	z.object({ kind: z.literal('RoomStopGame') }),
	z.object({ kind: z.literal('NightSubmitAction'), action: NightActionSubmissionSchema }),
	z.object({ kind: z.literal('NightAdvanceStage') }),
	z.object({ kind: z.literal('NightAnnounceResults') }),
	// M5 §9.1/9.3 - host-only queue advancement, shared by LAST_WORDS and
	// DISCUSSION (see engine.ts's NEXT_SPEAKER handler).
	z.object({ kind: z.literal('DayNextSpeaker') }),
	z.object({ kind: z.literal('DayBeginVote') }),
	z.object({ kind: z.literal('DaySelfExplode'), seat: z.number().int().positive() }),
	z.object({
		kind: z.literal('DayKnightDuel'),
		knightSeat: z.number().int().positive(),
		targetSeat: z.number().int().positive()
	}),
	z.object({
		kind: z.literal('VoteCast'),
		target: z.union([z.number().int().positive(), z.literal('abstain')])
	}),
	z.object({ kind: z.literal('VoteEnd') }),
	z.object({ kind: z.literal('HunterShoot'), target: z.number().int().positive().nullable() }),
	// M6 §10.5 上帝之手 - host-only manual override, any phase.
	z.object({
		kind: z.literal('HostOverride'),
		overrideKind: z.enum(['KILL', 'REVIVE', 'SET_ROLE']),
		seat: z.number().int().positive(),
		role: roleEnum.optional()
	}),
	z.object({ kind: z.literal('ResyncRequest') }),
	z.object({ kind: z.literal('NightNarrationStarted'), role: roleEnum })
]);
export type ClientAction = z.infer<typeof ClientActionSchema>;

export type AckResponse = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Server -> client, broadcast to the room (or, for PrivateInfo, to one
// session only via emitToSession - never mixed into the room broadcast).
// ---------------------------------------------------------------------------

export type ServerEvent =
	| { kind: 'StateSnapshot'; state: RoomPublicState }
	| { kind: 'SeatUpdated'; seats: RoomPublicState['seats'] }
	| { kind: 'LockUpdated'; locked: boolean }
	| { kind: 'RolesRerolled' }
	| { kind: 'GameReset' }
	| { kind: 'PhaseChanged'; phase: Phase; nightNumber: number }
	// S4: room-wide - never carries which role is acting, see PublicNightStage.
	| { kind: 'StageChanged'; stage: PublicNightStage | null }
	| { kind: 'NightAnnouncePending' }
	| { kind: 'NightResolved'; nightNumber: number; deaths: number[] }
	// S11: WHO has voted, never who they voted for or a running tally.
	| { kind: 'VoteUpdated'; votedSeats: number[]; totalVoters: number }
	| {
			kind: 'DayResolved';
			eliminatedSeat: number | null;
			identity: Role | null;
			tie: boolean;
			/** The eliminated seat's 丘比特 partner, if the vote also triggered
			 * 殉情 - null if there's no couple or the elimination didn't touch it. */
			followDeathSeat: number | null;
			followDeathIdentity: Role | null;
			/** M5 §9.4 - present only when a first-round tie just opened a
			 * VOTE_PK re-vote (eliminatedSeat stays null in that case) - the tied
			 * seats about to be re-voted on. */
			pkCandidates?: number[];
	  }
	// M5 §9.1 - who's up next in the last-words queue; null once it's drained
	// (the next PhaseChanged/StageChanged that follows says what comes after).
	| { kind: 'LastWordsSpeakerChanged'; seat: number | null }
	// M5 §9.3 - the (suggested, non-gating) speech order and whose turn it is.
	| { kind: 'DiscussionSpeakerChanged'; seat: number | null; order: number[] }
	// M5 §9.6 狼人自爆.
	| { kind: 'SelfExploded'; seat: number }
	// M5 §9.6 骑士决斗 - targetWasWolf tells every client which of the two
	// possible outcomes just happened (both are always fully public: the
	// duel reveals whoever it was aimed at regardless of the result).
	| { kind: 'KnightDuelResolved'; knightSeat: number; targetSeat: number; targetWasWolf: boolean }
	// M6 §10.5 上帝之手 - announces THAT the host overrode something, never the
	// new role for a SET_ROLE override (that would leak straight past every
	// secrecy mechanism this app has); a KILL/REVIVE's effect is already
	// visible via deadSeats changing.
	| { kind: 'HostOverrideApplied'; seat: number; overrideKind: 'KILL' | 'REVIVE' | 'SET_ROLE' }
	| { kind: 'HunterPending'; hunterSeat: number }
	| {
			kind: 'HunterResolved';
			hunterSeat: number;
			shotSeat: number | null;
			/** The shot seat's 丘比特 partner, if the shot also triggered 殉情 -
			 * same asymmetry as shotSeat itself: no identity revealed here either. */
			followDeathSeat: number | null;
	  }
	| {
			kind: 'GameOver';
			winner: Winner;
			identities: Record<number, Role>;
			/** The two 丘比特-linked seats, if any (regardless of team/winner -
			 * the reveal screen marks them either way, not just when they won). */
			coupleSeats: [number, number] | null;
	  }
	// Structured, not a baked message string - i18n needs this to stay a
	// client-only rendering concern (src/lib/shared/i18n/format.ts's
	// formatPlayerLeftMidGame/formatRoomClosedByHost), matching every other
	// error code in the app instead of being the one path that could only
	// ever speak Chinese.
	| { kind: 'ErrorToast'; reason: 'player_left_mid_game'; seat: number | null }
	| { kind: 'RoomClosed'; reason: 'host_left' }
	// S4: no role field - see gameStore's revealTurn, which doesn't need one
	// (pendingTurnRole is already unique to whoever's actual turn it is).
	| { kind: 'StageNarrationStarted' };

/**
 * Everything the acting player needs that only the server knows, delivered
 * privately alongside their turn prompt. In a physical game the host would say
 * these things aloud to that one player with everyone else's eyes closed.
 *
 * NEVER broadcast this. Several fields (the wolf teammate list above all, but
 * also the witch's kill readout and the hunter's poison status) would expose
 * hidden information if they ever reached the room channel - it must only
 * travel via emitToSession.
 */
export interface TurnContext {
	/** The recipient's own seat. The prompt component has no other way to know
	 * it: `mySeat` is derived at the room-page level and isn't passed down. */
	seat: number;
	witch?: {
		/** Tonight's 普通狼人 target, or null if nobody was attacked. */
		killedSeat: number | null;
		/** Still unspent for the whole game. Whether it's usable *right now*
		 * additionally depends on the self-save and one-potion-per-night rules,
		 * which the UI derives and the server re-checks on submit. */
		antidoteAvailable: boolean;
		poisonAvailable: boolean;
	};
	/** Sent on every 猎人 turn: the same hunterCanShoot() verdict the server
	 * will apply if they die tonight, shown live the way a physical host gives
	 * the hunter a thumbs up or down. */
	hunter?: { canShoot: boolean };
	guard?: { lastProtectedSeat: number | null };
	/** Living wolf-team seats other than the recipient's own. */
	wolf?: { teammateSeats: number[] };
}

export type PrivateInfo =
	| { kind: 'YourRole'; role: Role }
	| { kind: 'SeerResult'; targetSeat: number; isWolf: boolean }
	| { kind: 'CoupleRevealed'; partnerSeat: number }
	| { kind: 'ThiefChoice'; buried: [Role, Role] }
	| { kind: 'YourTurnPrompt'; role: Role; context: TurnContext }
	| { kind: 'HunterAuthorized' }
	| { kind: 'HunterDenied'; reason: 'poison' }
	// S4: acknowledges a role's submission - host-only (see effectTranslator's
	// emitToHost), since broadcasting it to everyone would out that role's
	// current holder as having just acted.
	| { kind: 'NightActionAck'; role: Role }
	/** Host-only counterpart to the room-wide (redacted) StageChanged - the
	 * real stage, role included, so JudgeAudioPlayer knows what to narrate. */
	| { kind: 'HostStageChanged'; stage: NightStage | null };
