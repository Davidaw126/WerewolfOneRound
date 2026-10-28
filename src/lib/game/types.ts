// Core type definitions for the pure game engine (需求规格说明书 v1.0 §12.1,
// 附录A#1). This file and its siblings under src/lib/game/ MUST NOT import
// from Svelte, Socket.IO, or Redis - the engine is a pure function over these
// types, built alongside the current (working) app and cut over in one
// commit once parity is proven. See the M0 plan for the full rationale.

import type { NightStage } from './rules/nightOrder';
import type { TurnContext } from './rules/turnContext';

// ---------------------------------------------------------------------------
// §4.1 Roles - the spec's 15-role roster, adopted exactly (a deliberate,
// user-confirmed decision to drop the current app's 8 extra mechanics-less
// roles: 禁言长老/高级村民/老流氓/隐狼/恶魔/机械狼, and to merge 梦魇
// into NIGHTMARE). Dropping 隐狼 also retires the open "hidden wolf leaks
// into the visible teammate list" concern from the old roleTeam()-based
// model - there's no longer a role that needs to be wolf-team for counting
// purposes but hidden from the wolf teammate reveal.
// ---------------------------------------------------------------------------

export type RoleId =
	| 'VILLAGER' // 平民
	| 'SEER' // 预言家
	| 'WITCH' // 女巫
	| 'HUNTER' // 猎人
	| 'GUARD' // 守卫
	| 'IDIOT' // 白痴
	| 'KNIGHT' // 骑士
	| 'DREAM_WEAVER' // 摄梦人
	| 'CUPID' // 丘比特
	| 'THIEF' // 盗贼
	| 'WILD_CHILD' // 野孩子
	| 'WEREWOLF' // 普通狼人
	| 'WOLF_KING' // 白狼王
	| 'BLACK_WOLF_KING' // 黑狼王
	| 'WOLF_BEAUTY' // 狼美人
	| 'NIGHTMARE'; // 恶灵骑士 (spec merges 梦魇 into this single role)

/** §3/§11.1. LOVERS is never a role's *base* camp - only getCamp()'s dynamic
 * result for a cross-team couple (+ the 丘比特 who linked them). */
export type Camp = 'GOOD' | 'WEREWOLF' | 'LOVERS';

// ---------------------------------------------------------------------------
// §10.1 Death causes - drives §10.4's hunter-shot eligibility and §10.2's
// upsertDeath severity ordering (B03/B50). The current app tracks deaths as
// a bare Set<seat>; this is the structural change that lets HUNTER_STATUS,
// idiot-reveal, and knight-duel all key off *why* someone died, not just
// *that* they did.
// ---------------------------------------------------------------------------

export type DeathCause =
	| 'WOLF_KILL'
	| 'WITCH_POISON'
	| 'VOTE_OUT'
	| 'HUNTER_SHOT'
	| 'WOLF_KING_SHOT'
	| 'LOVER_SUICIDE'
	| 'WOLF_BEAUTY_LINK'
	| 'SELF_EXPLODE'
	| 'KNIGHT_DUEL'
	| 'KNIGHT_DUEL_FAIL'
	| 'DREAM_WEAVER'
	| 'HOST_OVERRIDE'
	| 'DAY_OUT';

export interface Death {
	seat: Seat;
	cause: DeathCause;
}

// ---------------------------------------------------------------------------
// §7.1 Phases. Includes SEATING, which has no spec equivalent - the spec
// assumes seats are already resolved by the time DEALING starts, but this
// app maps N phones to N physical chairs around a real table, which the
// spec doesn't model at all. Kept as our own addition.
// // SPEC-GAP: SEATING (physical seat assignment) has no spec equivalent -
// // added for this app's real-table-seat-mapping requirement.
//
// M0-M1 only implement transitions through LOBBY / SEATING / DEALING /
// FIRST_NIGHT / NIGHT / DAWN / HUNTER_SHOOT / VOTE / GAME_OVER (today's
// existing flow, ported). SHERIFF_ELECTION / LAST_WORDS / DISCUSSION /
// VOTE_PK / EXILE are defined now (so GameState/RuleConfig don't need
// redesigning later) but their transition logic lands in M5.
// ---------------------------------------------------------------------------

export type Phase =
	| 'LOBBY'
	| 'SEATING' // SPEC-GAP: see above
	| 'DEALING'
	| 'FIRST_NIGHT'
	| 'NIGHT'
	| 'DAWN'
	| 'SHERIFF_ELECTION' // M5
	| 'LAST_WORDS' // M5
	| 'HUNTER_SHOOT'
	| 'DISCUSSION' // M5
	| 'VOTE'
	| 'VOTE_PK' // M5
	| 'EXILE' // M5
	| 'GAME_OVER';

export type Seat = number; // 1..N, stable for the whole game once dealt

// ---------------------------------------------------------------------------
// §6 RuleConfig - host-adjustable switches, snapshotted per game. Grouped
// exactly as the spec's lettered sections so the two stay easy to diff.
// Defaults noted inline; three of them (wolf.allowEmptyKill,
// idiot.revealOnExile's *absence* of a role broadcast, witch.selfRescue)
// take the spec's default per the user's explicit decision even though they
// change today's live behavior - see the M0 plan's decision table.
// ---------------------------------------------------------------------------

export interface RuleConfig {
	// ===== A. 胜负 =====
	/** Default 'SIDE_KILL' (屠边) per user decision - 'TOTAL_KILL' (today's
	 * wolves >= nonWolves rule) stays selectable via a checkbox. */
	winCondition: 'SIDE_KILL' | 'TOTAL_KILL';
	loversWinOverridesCamp: boolean; // default true
	cupidJoinsLoversCamp: boolean; // default true - matches the trio logic already shipped
	cupidWinsIfDead: boolean; // default true - already shipped behavior

	// ===== B. 白天 =====
	sheriffEnabled: boolean; // default true
	sheriffVoteWeight: number; // default 1.5
	sheriffDecidesSpeechOrder: boolean; // default true
	sheriffBadgeOnDeath: 'TRANSFER_OR_TEAR' | 'AUTO_TEAR'; // default 'TRANSFER_OR_TEAR'
	tieBreak: 'PK_THEN_NO_EXILE' | 'NO_EXILE' | 'RANDOM'; // default 'PK_THEN_NO_EXILE'
	allowAbstain: boolean; // default true
	sheriffMustVote: boolean; // default true
	lastWords: {
		firstNightVictim: boolean; // default true
		exiledPlayer: boolean; // default true
		hunterShotVictim: boolean; // default true
		nightVictimAfterFirst: boolean; // default false
	};
	/** default false (先竞选警长再报死讯) - only meaningful once M5's sheriff
	 * election exists; purely about ORDER relative to the election, not
	 * whether the announcement itself is automatic. Separately (a structural
	 * choice, not a RuleConfig field): this app keeps its own
	 * host-taps-「公布夜晚结果」step (GameState.pendingNightAnnounce) instead
	 * of the spec's automatic-on-DAWN announcement - see the M0 plan's
	 * decision 7. That's an architectural difference, not a switch. */
	announceDeathBeforeSheriff: boolean;
	/** default true - a 猎人/黑狼王 shot is public, so it happens at the table
	 * and the host records the victim with DAY_OUT, instead of the app
	 * stopping in HUNTER_SHOOT for the shooter to pick on their phone. */
	shotsAtTable: boolean;

	// ===== C. 夜晚 =====
	stepTimeoutSec: number; // default 30, 0 = unlimited
	timeoutBehavior: 'SKIP' | 'PAUSE'; // default 'SKIP'

	// ===== D. 角色细则 =====
	wolf: {
		/** Default true per user decision (spec default) - today's schema
		 * requires a target; this makes 空刀 possible. */
		allowEmptyKill: boolean;
		decisionRule: 'MAJORITY_ELSE_EMPTY' | 'HOST_DECIDES'; // default 'HOST_DECIDES'
		allowSelfExplode: boolean; // default true
		selfExplodeEndsDay: boolean; // default true
		selfExplodeHasLastWords: boolean; // default false
		wolfKingExplodeCanShoot: boolean; // default true
		/** 黑狼王 dying of 殉情 still gets his shot. Default false. */
		blackWolfKingCanShootWhenLoverSuicide: boolean;
	};
	seer: {
		/** Default TRUE, not the spec's stated false - today's night-action
		 * schema and UI have no self-check restriction at all (the seer's
		 * target picker includes their own seat, unvalidated server-side too),
		 * so unrestricted is the actual current behavior. */
		canCheckSelf: boolean;
		allowRecheck: boolean; // default true
		/** Already shipped as the only behavior - kept as a switch for spec
		 * parity, but 'EXACT_ROLE' is not implemented (out of scope). */
		resultGranularity: 'GOOD_BAD' | 'EXACT_ROLE';
	};
	witch: {
		knowsVictimOnFirstNight: boolean; // default true
		knowsVictimEveryNight: boolean; // default true
		/** Default 'FIRST_NIGHT_ONLY' per user decision (spec default) - today
		 * forbids self-rescue entirely, on every night. */
		selfRescue: 'FIRST_NIGHT_ONLY' | 'NEVER' | 'ALWAYS';
		bothPotionsSameNight: boolean; // default false, matches today
		/** Default TRUE, not the spec's stated false - today's poison target
		 * picker includes the witch's own seat with no restriction, client or
		 * server side, so unrestricted is the actual current behavior. */
		canPoisonSelf: boolean;
		mustOpenEyesWhenEmpty: boolean; // default true (假环节, see M4)
	};
	guard: {
		canGuardSameTargetConsecutively: boolean; // default false, matches today
		canGuardSelf: boolean; // default true
		sameGuardSameSave: 'TARGET_DIES' | 'TARGET_LIVES'; // default 'TARGET_DIES', matches today
		protectsAgainstPoison: boolean; // default false, matches today
	};
	hunter: {
		canShootWhenPoisoned: boolean; // default false, matches today
		canShootWhenExiled: boolean; // default true
		canShootWhenWolfKilled: boolean; // default true
		/** Default TRUE, deliberately NOT the spec's stated false - today's
		 * hunterCanShoot() only denies a lover-suicide hunter in the narrow
		 * case their specific partner was poisoned AND cupidPoisonBlocksHunter
		 * is on (default off); a lover-suicide hunter whose partner died to
		 * anything else can already shoot today. Matching the spec's blanket
		 * false here would be a real behavior change nothing asked for -
		 * true preserves today's default, and cupidPoisonBlocksHunter below
		 * still layers its narrower poison-specific denial on top. */
		canShootWhenLoverSuicide: boolean;
	};
	idiot: {
		revealOnExile: boolean; // default true
		keepsSpeechRight: boolean; // default true
		losesVoteRight: boolean; // default true
		canRunForSheriffAfterReveal: boolean; // default false
		tearsBadgeIfSheriff: boolean; // default true
		diesNormallyAtNight: boolean; // default true
	};
	knight: {
		duelEndsDayIfWolf: boolean; // default true
		knightDiesIfGood: boolean; // default true
		onceOnly: boolean; // default true
	};
	cupid: {
		canLinkSelf: boolean; // default true
		loversSeeEachOtherRole: boolean; // default true
		suicideTriggersHunter: boolean; // default false
	};
	thief: {
		mustTakeWolfIfBothWolf: boolean; // default true
	};
	wildChild: {
		wolvesSeeConvertedChild: boolean; // default true
		childSeesWolvesAfterConvert: boolean; // default true
	};

	// ===== Not in the spec's RuleConfig, but referenced by nightRules.ts
	// today - kept as its own switch rather than folded into `hunter`/`witch`
	// since it's specifically about the CUPID interaction. =====
	/** House rule (default false): layers ON TOP of hunter.canShootWhenLoverSuicide
	 * above - even when that's true (today's default), a hunter who dies via
	 * lover-suicide specifically because their linked partner was POISONED is
	 * still denied, same as being poisoned directly. Already shipped. */
	cupidPoisonBlocksHunter: boolean;

	// SPEC-GAP: dead players seeing all roles (B48) isn't in §6's RuleConfig
	// table but is referenced by viewFilter.ts (§12.2) - added here.
	deadSeeAllRoles: boolean; // default true
}

// ---------------------------------------------------------------------------
// §5 Setup - the role-count configuration for one game, plus the counts
// checkWinCondition's SIDE_KILL branch needs (hadGods/hadVillagers).
// ---------------------------------------------------------------------------

export interface Setup {
	roleConfig: Partial<Record<RoleId, number>>;
	numberOfSeats: number;
	godCount: number;
	villagerCount: number;
}

// ---------------------------------------------------------------------------
// §12.1 Player + GameState
// ---------------------------------------------------------------------------

export interface Player {
	seat: Seat;
	sessionId: string;
	nickname: string;
	connected: boolean;
	lastSeenAt: number;

	// --- MUST NOT be sent to any other player - see viewFilter.ts (M4) ---
	role: RoleId;
	convertedToWolf: boolean; // 野孩子 (M7)
	thiefExtraCards?: RoleId[]; // 盗贼's buried pair, visible only to the thief

	// --- Public fields ---
	isDead: boolean;
	deathCause?: DeathCause;
	deathRound?: number;
	isRevealedIdiot: boolean;
	revealedRole?: RoleId;
	hasVoteRight: boolean;
	hasViewedIdentity: boolean;
}

export interface NightActions {
	guardTarget?: Seat;
	wolfKillTarget?: Seat | null; // null = 空刀
	wolfBeautyCharmTarget?: Seat;
	nightmareFearTarget?: Seat;
	witchAntidoteTarget?: Seat; // must equal wolfKillTarget
	witchPoisonTarget?: Seat;
	seerCheckTarget?: Seat;
	dreamWeaverTarget?: Seat;
	// First-night-only
	cupidLinks?: [Seat, Seat];
	wildChildIdol?: Seat;
	thiefPick?: RoleId;
}

export interface TimelineEvent {
	round: number;
	phase: Phase;
	visibility: 'PUBLIC' | 'PRIVATE';
	/** Only meaningful when visibility is 'PRIVATE' - whose eyes this is for. */
	forSeat?: Seat;
	text: string;
	at: number; // epoch ms
}

export interface GameState {
	roomCode: string;
	/** When this game started (startGame's `now`) - tells one game in a room
	 * apart from the next. Absent on games saved before it existed. */
	startedAt?: number;
	phase: Phase;
	round: number;
	isFirstNight: boolean;
	ruleConfig: RuleConfig;
	setup: Setup;
	players: Record<Seat, Player>;

	// --- Night ---
	currentStepKey: string | null;
	stepDeadline: number | null;
	nightActions: NightActions;
	/** Not spec-derived - roles that have already submitted THIS night, reset
	 * every time a fresh night begins. WITCH/GUARD need this: a legitimate
	 * empty turn (witch declines both potions, guard's targetSeat backed out)
	 * leaves no trace in `nightActions`, so "already submitted" can't be
	 * inferred from the action data alone the way it can for e.g. WEREWOLF
	 * (whose single shared field a resubmit just harmlessly overwrites). */
	submittedRoles: RoleId[];
	lastGuardTarget: Seat | null;
	lastDreamTarget: Seat | null;
	charmedSeat: Seat | null;
	fearedSeat: Seat | null;

	// --- Identity links ---
	lovers: [Seat, Seat] | null;
	cupidSeat: Seat | null;
	wildChildSeat: Seat | null;
	wildChildIdol: Seat | null;

	// --- Day (M5) ---
	sheriffSeat: Seat | null;
	badgeTorn: boolean;
	speechOrder: Seat[];
	currentSpeaker: Seat | null;
	votes: Record<Seat, Seat | 'ABSTAIN'>;
	pkCandidates: Seat[];

	// --- Blocking queues ---
	pendingShoots: Seat[];
	pendingLastWords: Seat[];
	pendingBadgeTransfer: Seat | null;
	returnPhase: Phase | null;

	/** Not spec-derived - a structural choice this app keeps (decision 7):
	 * the night's death list is computed and applied to `players[].isDead`
	 * immediately, but held back from any broadcast until the host explicitly
	 * announces it (ANNOUNCE_NIGHT_RESULTS), instead of the spec's automatic
	 * DAWN announcement. null once there's nothing pending. */
	pendingNightDeaths: Death[] | null;

	// --- Records ---
	witchAntidoteUsed: boolean;
	witchPoisonUsed: boolean;
	knightUsed: boolean;
	/** Today's outcome is settled - someone was exiled (or flipped as the
	 * 白痴), or a self-explosion / successful duel ended the day. The host's
	 * only move left is 进入下一夜 (END_DAY). Cleared each night. */
	dayDecided: boolean;
	/** Seats that tapped 确认 on the current eyes-open-only stage (情侣相认
	 * needs every living lover) - reset on every stage change. Optional so a
	 * game saved before this field existed still loads. */
	stageConfirms?: Seat[];
	hostOverrideCount: number;
	timeline: TimelineEvent[];

	winner: Camp | null;
}

// ---------------------------------------------------------------------------
// Engine action + effect shapes (§2.1.2). Deliberately narrow for M0 - only
// the actions today's app already supports are enumerated here; day-phase
// actions (sheriff:*, judge:hunterShoot, etc.) land with M5.
// ---------------------------------------------------------------------------

export type EngineAction =
	| { type: 'SUBMIT_NIGHT_ACTION'; seat: Seat; role: RoleId; action: Partial<NightActions> }
	/** `expectedStepKey`, when present, gates the advance on `currentStepKey`
	 * still matching it - the IO shell's delayed auto-advance (fired
	 * POST_ACTION_PAUSE_MS after a submission, mirroring the old app) passes
	 * the stage it observed at schedule time, so a stale timer that fires
	 * after the stage already moved on (a host's manual tap, or another
	 * player's own timer winning the race) safely no-ops instead of
	 * double-advancing past the stage that came next. Omitted entirely for a
	 * host's manual tap, which always advances whatever the current stage is. */
	| { type: 'ADVANCE_STAGE'; expectedStepKey?: string | null }
	/** Host-only, decision 7: publishes `pendingNightDeaths` (already applied
	 * to `players[].isDead`) as a BROADCAST and clears the pending field. No
	 * spec counterpart - the spec announces automatically on DAWN. */
	| { type: 'ANNOUNCE_NIGHT_RESULTS' }
	/** Host-only. Advances the LAST_WORDS or DISCUSSION speaker queue - a no-op
	 * outside those two phases. LAST_WORDS draining triggers whatever comes
	 * next (hunter-shoot check, then DISCUSSION or NIGHT per §7.2); DISCUSSION
	 * just moves `currentSpeaker` along `speechOrder` (a suggested order, not
	 * a hard gate - BEGIN_VOTE can fire at any point regardless). */
	| { type: 'NEXT_SPEAKER' }
	/** Host-only, §9.4 step 1 - "房主点击 [开始投票]". DISCUSSION -> VOTE. */
	| { type: 'BEGIN_VOTE' }
	/** Host-only "进入黑夜": ends the day with no exile - e.g. a wolf
	 * self-exploded at the table. DISCUSSION/VOTE/VOTE_PK -> NIGHT, after
	 * the usual winner check. */
	| { type: 'END_DAY' }
	/** Host-only: the table voted by hand and the host records who is
	 * exiled (DISCUSSION, once per day). Same consequences as a tallied vote
	 * - 白痴 flip, 殉情, hunter/wolf-king shot, winner check - but the day
	 * then waits for END_DAY instead of starting the night itself. */
	| { type: 'EXILE'; seat: Seat }
	| { type: 'DAY_OUT'; seats: Seat[] }
	| { type: 'CONFIRM_STAGE'; seat: Seat }
	| { type: 'CAST_VOTE'; seat: Seat; target: Seat | 'ABSTAIN' }
	/** `random`, when present, picks the tied leader for tieBreak='RANDOM'
	 * (index into the seat-ascending leader list, wrapped via modulo) - kept
	 * pure/replay-safe the same way the rest of this file avoids Date.now():
	 * the IO shell supplies Math.random() at call time, the engine never
	 * generates its own entropy. Irrelevant for every other tieBreak value. */
	| { type: 'TALLY_VOTES'; random?: number }
	| { type: 'HUNTER_SHOOT'; shooterSeat: Seat; targetSeat: Seat | null }
	/** §9.6 狼人自爆 (M3) - host declares a wolf-camp seat self-exploded.
	 * Reachable during VOTE (a stand-in for the spec's DISCUSSION phase, not
	 * built until M5 - see the M3 program notes for why). */
	| { type: 'SELF_EXPLODE'; seat: Seat }
	/** §9.6 骑士决斗 (M3) - host reveals `targetSeat`'s camp via the knight's
	 * duel. Same VOTE-phase stand-in as SELF_EXPLODE. */
	| { type: 'KNIGHT_DUEL'; knightSeat: Seat; targetSeat: Seat }
	| { type: 'HOST_OVERRIDE'; kind: 'KILL' | 'REVIVE' | 'SET_ROLE'; seat: Seat; role?: RoleId };

/** Everything the engine can tell the room (BROADCAST) or one seat
 * (PRIVATE). The IO shell's effectTranslator turns these into socket
 * events; most travel unchanged, a few are reshaped or split there. */
export type EnginePayload =
	// The IO shell broadcasts the phase itself (gameSync); DAWN is how the
	// room learns the night's results are waiting for the Host.
	| { kind: 'PhaseChanged'; phase: Phase; nightNumber: number }
	| { kind: 'NightAnnouncePending' }
	// Becomes the submitter's ack error, never a sent event.
	| { kind: 'NightActionRejected'; error: string }
	| {
			kind: 'HostOverrideApplied';
			seat: Seat;
			overrideKind: 'KILL' | 'REVIVE' | 'SET_ROLE';
			deaths?: Seat[];
	  }
	| { kind: 'StageChanged'; stage: NightStage | null }
	| { kind: 'LastWordsSpeakerChanged'; seat: Seat | null }
	| { kind: 'DiscussionSpeakerChanged'; seat: Seat | null; order: Seat[] }
	| { kind: 'DayDecided' }
	| { kind: 'DayOut'; seats: Seat[]; followDeaths: Seat[] }
	| { kind: 'SelfExploded'; seat: Seat }
	| {
			kind: 'KnightDuelResolved';
			knightSeat: Seat;
			targetSeat: Seat;
			targetWasWolf: boolean;
			deaths: Seat[];
	  }
	| { kind: 'NightResultsAnnounced'; deaths: Death[]; nightNumber: number }
	| { kind: 'HunterPending'; hunterSeat: Seat }
	| { kind: 'HunterAuthorized' }
	| { kind: 'HunterDenied'; reason: 'poison' }
	| {
			kind: 'HunterResolved';
			hunterSeat: Seat;
			shotSeat: Seat | null;
			followDeathSeat: Seat | null;
	  }
	| { kind: 'PackKillChosen'; bySeat: Seat; target: Seat | null }
	| { kind: 'RoleDoneByOther' }
	| { kind: 'StageConfirmed' }
	| { kind: 'ShotStatus'; canShoot: boolean }
	| {
			kind: 'DayResolved';
			eliminatedSeat: Seat | null;
			identity: RoleId | null;
			tie: boolean;
			followDeathSeat: Seat | null;
			followDeathIdentity: RoleId | null;
			idiotRevealed?: boolean;
			pkCandidates?: Seat[];
	  }
	| { kind: 'VoteUpdated'; votedSeats: Seat[]; totalVoters: number }
	| {
			kind: 'GameOver';
			winner: Camp;
			identities: Record<Seat, RoleId>;
			coupleSeats: [Seat, Seat] | null;
	  }
	| { kind: 'NightActionAck'; role: RoleId }
	| { kind: 'YourRole'; role: RoleId }
	| { kind: 'SeerResult'; targetSeat: Seat; isBad: boolean }
	| { kind: 'CoupleRevealed'; partnerSeat: Seat }
	| { kind: 'ThiefChoice'; buried: RoleId[] }
	| { kind: 'YourTurnPrompt'; role: RoleId; context: TurnContext; replay?: boolean };

export interface EngineEffect {
	/** Effects are side-effect *descriptions* the IO shell (M1) turns into
	 * actual socket emits - the engine itself never touches a socket. */
	kind: 'BROADCAST' | 'PRIVATE';
	seat?: Seat; // required when kind === 'PRIVATE'
	payload: EnginePayload;
}

export interface EngineResult {
	state: GameState;
	effects: EngineEffect[];
}
