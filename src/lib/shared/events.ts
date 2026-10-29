import { z } from 'zod';
import { ALL_ROLE_IDS } from '../game/roleMeta';
import { RuleConfigOverridesSchema } from '../game/ruleSwitches';
import type { RoleId } from '../game/types';
import type { ValidationIssue } from '../game/rules/setup';
import type { TurnContext } from '../game/rules/turnContext';
import type { ActionErrorCode } from './actionErrors';
import type { Phase, NightStage, PublicNightStage, RoomPublicState, Winner } from './gameTypes';

export type { TurnContext };

// ---------------------------------------------------------------------------
// Client -> server. One socket event name ('client:action') carries all of
// these as a discriminated union, validated server-side by the matching zod
// schema before anything touches Redis. Every action is answered with its
// ActionReply (below): what its success carries, or a Refusal with a code.
// ---------------------------------------------------------------------------

// Roles travel as the engine's RoleId everywhere on the wire; display names
// are a client-only concern (shared/i18n/roles.ts).
const roleEnum = z.enum(ALL_ROLE_IDS as unknown as [RoleId, ...RoleId[]]);

// The Host's rule switches are defined once, in the engine (ruleSwitches.ts).
export { RuleConfigOverridesSchema, type RuleConfigOverrides } from '../game/ruleSwitches';

export const NightActionSubmissionSchema = z.discriminatedUnion('role', [
	// nullable (空刀/empty kill) - the engine's own wolf.allowEmptyKill switch
	// (M2, default true) decides whether a null target is actually accepted;
	// this schema only gates the *shape*, same split as 女巫's poisonTarget.
	z.object({ role: z.literal('WEREWOLF'), targetSeat: z.number().int().positive().nullable() }),
	// 白狼王 (M3) shares 普通狼人's collective kill decision - same shape, same
	// nullable target - it has no separate night action of its own (see
	// roleMeta.ts's WOLF_KING.nightOrder comment).
	z.object({ role: z.literal('WOLF_KING'), targetSeat: z.number().int().positive().nullable() }),
	// 黑狼王 also shares the pack's kill - his own skill is the death shot.
	z.object({
		role: z.literal('BLACK_WOLF_KING'),
		targetSeat: z.number().int().positive().nullable()
	}),
	z.object({ role: z.literal('SEER'), targetSeat: z.number().int().positive() }),
	z.object({
		role: z.literal('WITCH'),
		poisonTarget: z.number().int().positive().nullable(),
		useAntidote: z.boolean()
	}),
	z.object({ role: z.literal('GUARD'), targetSeat: z.number().int().positive() }),
	// Nullable only for the pack's 空刀 - they join the pack's kill turn too.
	z.object({ role: z.literal('WOLF_BEAUTY'), targetSeat: z.number().int().positive().nullable() }),
	z.object({
		role: z.literal('CUPID'),
		seatA: z.number().int().positive(),
		seatB: z.number().int().positive()
	}),
	z.object({ role: z.literal('THIEF'), swap: z.enum(['buried1', 'buried2']).nullable() }),
	// M7
	z.object({ role: z.literal('WILD_CHILD'), targetSeat: z.number().int().positive() }),
	z.object({ role: z.literal('DREAM_WEAVER'), targetSeat: z.number().int().positive() }),
	z.object({ role: z.literal('NIGHTMARE'), targetSeat: z.number().int().positive().nullable() })
]);
export type NightActionSubmission = z.infer<typeof NightActionSubmissionSchema>;

export const ClientActionSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('RoomCreate') }),
	z.object({ kind: z.literal('RoomJoin'), roomCode: z.string().regex(/^\d{6}$/) }),
	z.object({
		kind: z.literal('RoomSubmitConfig'),
		roleConfig: z.partialRecord(roleEnum, z.number().int().min(0)),
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
	// A feared player's only move: end their turn without using their skill.
	z.object({ kind: z.literal('NightPass') }),
	z.object({ kind: z.literal('NightAdvanceStage') }),
	z.object({ kind: z.literal('NightAnnounceResults') }),
	// M5 §9.1/9.3 - host-only queue advancement, shared by LAST_WORDS and
	// DISCUSSION (see engine.ts's NEXT_SPEAKER handler).
	z.object({ kind: z.literal('DayNextSpeaker') }),
	z.object({ kind: z.literal('DayBeginVote') }),
	// Host-only "进入黑夜": skip (the rest of) today's vote and start the night.
	z.object({ kind: z.literal('DayEndDay') }),
	// Host-only: record who the table voted out by hand (once per day).
	z.object({ kind: z.literal('DayExile'), seat: z.number().int().positive() }),
	// Host-only: the seats that left the table today (exile, self-explode,
	// a shot) - several at once; the server adds any 殉情.
	z.object({
		kind: z.literal('DayOut'),
		seats: z.array(z.number().int().positive()).min(1).max(20)
	}),
	z.object({ kind: z.literal('DaySelfExplode'), seat: z.number().int().positive() }),
	// A player's own 确认 on the 开枪状态 / 情侣相认 stages (eyes shut for
	// everyone else, including the host).
	z.object({ kind: z.literal('NightConfirmStage') }),
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

/** A refused action's reply. `issues`: the setup checks behind an E-code. */
export type Refusal = { ok: false; error: ActionErrorCode; issues?: ValidationIssue[] };

export const refuse = (error: ActionErrorCode, issues?: ValidationIssue[]): Refusal =>
	issues ? { ok: false, error, issues } : { ok: false, error };

/** What a successful reply carries, for the actions whose success carries
 * anything; every other action answers a bare `{ ok: true }`. */
interface ReplyData {
	RoomCreate: { roomCode: string; state: RoomPublicState };
	RoomJoin: { state: RoomPublicState };
	ResyncRequest: { state: RoomPublicState };
	/** Warnings (E09) that didn't stop the setup. */
	RoomSubmitConfig: { issues?: ValidationIssue[] };
}

export type ActionKind = ClientAction['kind'];
export type ActionOf<K extends ActionKind> = Extract<ClientAction, { kind: K }>;
export type ActionReply<K extends ActionKind = ActionKind> =
	({ ok: true } & (K extends keyof ReplyData ? ReplyData[K] : unknown)) | Refusal;
/** The reply of an action whose success carries nothing. */
export type AckResponse = { ok: true } | Refusal;

// ---------------------------------------------------------------------------
// Server -> client, broadcast to the room (or, for PrivateInfo, to one
// session only via emitToSession - never mixed into the room broadcast).
// ---------------------------------------------------------------------------

export type ServerEvent =
	| { kind: 'StateSnapshot'; state: RoomPublicState }
	| { kind: 'SeatUpdated'; seats: RoomPublicState['seats'] }
	| { kind: 'LockUpdated'; locked: boolean }
	// reason: absent when the Host tapped 重新分配角色; 'seen_role_left' when a
	// player who had looked at their role left during seating.
	| { kind: 'RolesRerolled'; reason?: 'seen_role_left' }
	| { kind: 'GameReset' }
	| { kind: 'PhaseChanged'; phase: Phase; nightNumber: number }
	// S4: room-wide - never carries which role is acting, see PublicNightStage.
	| { kind: 'StageChanged'; stage: PublicNightStage | null }
	| { kind: 'NightResolved'; nightNumber: number; deaths: number[] }
	/** Who is dead and which 白痴 have flipped, as the room may know it -
	 * sent whenever an action changes either. Night deaths only appear once
	 * the Host has announced them. The one source phones take this from. */
	| { kind: 'DeathsUpdated'; deadSeats: number[]; revealedIdiots: number[] }
	// S11: WHO has voted, never who they voted for or a running tally.
	| { kind: 'VoteUpdated'; votedSeats: number[]; totalVoters: number }
	| {
			kind: 'DayResolved';
			eliminatedSeat: number | null;
			identity: RoleId | null;
			tie: boolean;
			/** The eliminated seat's 丘比特 partner, if the vote also triggered
			 * 殉情 - null if there's no couple or the elimination didn't touch it. */
			followDeathSeat: number | null;
			followDeathIdentity: RoleId | null;
			/** §9.5: the exiled seat was a not-yet-revealed 白痴 - they flipped
			 * their card and STAY ALIVE (without a vote) instead of leaving. */
			idiotRevealed?: boolean;
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
	/** Today's outcome is settled - see RoomPublicState.dayDecided. */
	| { kind: 'DayDecided' }
	/** The host recorded these seats as out; followDeaths are the 殉情
	 * deaths the app added on top. */
	| { kind: 'DayOut'; seats: number[]; followDeaths: number[] }
	// M5 §9.6 骑士决斗 - targetWasWolf tells every client which of the two
	// possible outcomes just happened (both are always fully public: the
	// duel reveals whoever it was aimed at regardless of the result).
	| {
			kind: 'KnightDuelResolved';
			knightSeat: number;
			targetSeat: number;
			targetWasWolf: boolean;
			/** Everyone who died: the loser (unless a house rule spares a
			 * knight) and anyone who fell with them (殉情 etc.). */
			deaths: number[];
	  }
	// M6 §10.5 上帝之手 - announces THAT the host overrode something, never the
	// new role for a SET_ROLE override (that would leak straight past every
	// secrecy mechanism this app has); a KILL/REVIVE's effect is already
	// visible via deadSeats changing.
	| {
			kind: 'HostOverrideApplied';
			seat: number;
			overrideKind: 'KILL' | 'REVIVE' | 'SET_ROLE';
			/** KILL: everyone who died - the seat plus any 殉情 it caused. */
			deaths: number[];
	  }
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
			identities: Record<number, RoleId>;
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

export type PrivateInfo =
	| { kind: 'YourRole'; role: RoleId }
	| { kind: 'SeerResult'; targetSeat: number; isWolf: boolean }
	| { kind: 'CoupleRevealed'; partnerSeat: number }
	| { kind: 'ThiefChoice'; buried: [RoleId, RoleId] }
	// `replay`: re-sent after a reconnect/reload (see turnReplay.ts) - the
	// stage's narration already played, so the client shows it immediately
	// instead of waiting on a StageNarrationStarted that won't come again.
	| { kind: 'YourTurnPrompt'; role: RoleId; context: TurnContext; replay?: boolean }
	| { kind: 'HunterAuthorized' }
	| { kind: 'HunterDenied'; reason: 'poison' }
	/** You (猎人/狼王/黑狼王) just died - may you shoot, at the table? */
	| { kind: 'ShotStatus'; canShoot: boolean }
	/** Your 确认 on an eyes-open-only stage (开枪状态/情侣相认) landed. */
	| { kind: 'StageConfirmed' }
	/** Another holder of your role already used tonight's turn. */
	| { kind: 'RoleDoneByOther' }
	/** 上帝之手 改变身份 - only the host and that seat's player hear of it;
	 * a room-wide notice would point every player at that seat. */
	| { kind: 'RoleChangedByHost'; seat: number; forYou: boolean }
	/** A teammate made tonight's pack kill (null = 空刀) - close your eyes. */
	| { kind: 'PackKillChosen'; bySeat: number; target: number | null }
	// S4: acknowledges a role's submission - host-only (see effectTranslator's
	// emitToHost), since broadcasting it to everyone would out that role's
	// current holder as having just acted.
	| { kind: 'NightActionAck'; role: RoleId }
	/** Host-only counterpart to the room-wide (redacted) StageChanged - the
	 * real stage, role included, so JudgeAudioPlayer knows what to narrate. */
	| { kind: 'HostStageChanged'; stage: NightStage | null };
