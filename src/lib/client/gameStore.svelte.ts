import {
	phaseGroup,
	type NightStage,
	type RoomPublicState,
	type SeatState,
	type Winner
} from '$lib/shared/gameTypes';
import type { RoleId } from '$lib/game/types';
import type { ServerEvent, PrivateInfo, TurnContext } from '$lib/shared/events';
import { onServerEvent, onPrivateEvent, onActionError } from './socket';
import { i18n } from './i18n.svelte';
import { line as logLine, isLogLine, type LogLine, type Round } from './logLines';
import {
	strings,
	formatRolesReshuffled,
	formatRolesReshuffledConfirm,
	formatHunterDenied,
	formatShotStatus,
	formatActionError,
	formatHunterAuthorized,
	formatRoomClosedByHost,
	formatPlayerLeftMidGame
} from '$lib/shared/i18n';

export type TimeOfDay = 'neutral' | 'night' | 'day' | Winner;

export interface VoteView {
	inPk: boolean;
	/** Seats this phone may vote for. */
	targets: SeatState[];
	votedCount: number;
	totalVoters: number;
	alreadyVoted: boolean;
	/** A flipped 白痴 stays in the game but has lost their vote. */
	revealedIdiot: boolean;
	/** A PK candidate is voted on, not voting. */
	pkCandidate: boolean;
	canVote: boolean;
}

export interface TurnRules {
	/** The pack's kill turn - 狼美人/恶灵骑士 pick the kill here, not their skill. */
	packTurn: boolean;
	killedSeat: number | null;
	guardLastSeat: number | null;
	wolfTeammates: number[];
	isSelfKill: boolean;
	noSelfPick: boolean;
	onePotionOnly: boolean;
}

/** One diary line: when, what (as data - see client/logLines.ts), and
 * whether everyone at the table learned it too. */
export interface ActivityLogEntry {
	round: Round;
	line: LogLine;
	public: boolean;
}

// The diary survives a page reload (iPhone Safari reloads a backgrounded tab
// whenever it's short on memory) - otherwise a seer lost every check result.
// One saved diary per device, tagged with the game it belongs to.
const LS_DIARY = 'wolf.diary';

function saveDiary(roomCode: string, gameId: string, log: ActivityLogEntry[]): void {
	try {
		localStorage.setItem(LS_DIARY, JSON.stringify({ roomCode, gameId, log }));
	} catch {
		/* private mode / quota - the diary just won't survive a reload */
	}
}

function loadDiary(roomCode: string, gameId: string): ActivityLogEntry[] {
	try {
		const saved = JSON.parse(localStorage.getItem(LS_DIARY) ?? 'null');
		// A diary saved by an older version (finished text) is dropped.
		if (saved?.roomCode === roomCode && saved?.gameId === gameId && Array.isArray(saved.log))
			return saved.log.filter((e: { line?: unknown }) => isLogLine(e?.line));
	} catch {
		/* unreadable - start empty */
	}
	return [];
}

export interface RoomLogEntry {
	round: Round;
	line: LogLine;
}

/** How long a role's night-turn prompt can stay held back waiting for its
 * narration line to actually start speaking, before showing anyway. Chosen
 * with margin over the worst normal-path delay (a short phase-intro line +
 * the 3s NARRATION_GAP_MS gap before the role line starts, for the very
 * first role turn of a night) - in the healthy-audio case the real
 * StageNarrationStarted signal always wins and this is dead code; it only
 * matters when narration is muted/unsupported/never relays. */
const TURN_REVEAL_FALLBACK_MS = 8000;

/** Central client-side game state, updated reactively as `server:event`s
 * arrive. One instance shared across the whole room/game screen - avoids
 * every component re-deriving state from raw socket events independently. */
export class GameStore {
	state = $state<RoomPublicState | null>(null);
	/** Host-only, and only ever non-null on the host's own client - the real
	 * current stage (role included), fed by StateSnapshot's hostStage and kept
	 * live by HostStageChanged. Everyone's shared `state.stage` is role-redacted
	 * (S4) - JudgeAudioPlayer reads this instead. */
	hostStage = $state<NightStage | null>(null);

	lastNightDeaths = $state<number[] | null>(null);
	lastDayResult = $state<{
		eliminatedSeat: number | null;
		identity: RoleId | null;
		tie: boolean;
		followDeathSeat: number | null;
		followDeathIdentity: RoleId | null;
		idiotRevealed: boolean;
	} | null>(null);
	lastHunterResult = $state<{
		hunterSeat: number;
		shotSeat: number | null;
		followDeathSeat: number | null;
	} | null>(null);
	gameOverResult = $state<{
		winner: Winner;
		identities: Record<number, RoleId>;
		coupleSeats: [number, number] | null;
	} | null>(null);

	/** Whose phone this is - the room page sets it from its own session. */
	viewerSessionId = $state<string | null>(null);
	/** This phone tapped 我知道了 on 情侣相认. Every phone has the button and
	 * only the lovers' taps count, so it's set from the tap's ack, not a
	 * server event; cleared on every stage change. */
	coupleConfirmed = $state(false);

	myRole = $state<RoleId | null>(null);
	/** This phone's 确认 on the current 开枪状态/情侣相认 stage landed. */
	stageConfirmed = $state(false);
	/** A wolf teammate already made tonight's kill (this stage only). */
	packKill = $state<{ bySeat: number; target: number | null } | null>(null);
	/** Another holder of this role (a 上帝之手 duplicate) already acted. */
	roleDoneByOther = $state(false);
	myTurnRole = $state<RoleId | null>(null);
	/** Private per-turn info for whoever is acting - see TurnContext. */
	turnContext = $state<TurnContext | null>(null);
	/** The most recent 预言家 check result, mirrored out of the activity log so
	 * the prompt can show it inline (the log entry remains the lasting record).
	 * Deliberately NOT cleared on StageChanged. */
	lastSeerResult = $state<{ targetSeat: number; isWolf: boolean } | null>(null);
	/** Set by CoupleRevealed, well before the COUPLE_REVEAL stage actually
	 * begins (that private event arrives the instant 丘比特 submits; the stage
	 * itself only starts after the usual post-action pacing pause) - held
	 * here rather than shown immediately so the reveal happens on the
	 * player's own tap during that stage, not the moment 丘比特 acts. */
	myPartnerSeat = $state<number | null>(null);

	/** Set by YourTurnPrompt the instant the server enters this role's turn -
	 * held back from myTurnRole/turnContext until a StageNarrationStarted
	 * (or the fallback timer) promotes it, so the prompt card doesn't appear
	 * before the role's own narration line has actually started. */
	pendingTurnRole = $state<RoleId | null>(null);
	pendingTurnContext = $state<TurnContext | null>(null);

	/** Centered, auto-dismissing popup for a private role result (seer check,
	 * hunter authorization/denial, couple reveal) - same overlay treatment as
	 * the confirm/role-reveal dialogs (a neighbor glancing at the screen
	 * shouldn't see it either), but never blocks on a tap since it's only
	 * information, not a decision. Separate from confirmToast/toast (the
	 * top-of-page banners), which are easy to miss while scrolled down into a
	 * night-action prompt. */
	infoPopup = $state<{ message: string; tone: 'good' | 'bad' | 'neutral' } | null>(null);
	private infoPopupToken = 0;

	hunterAuthorized = $state(false);
	thiefChoice = $state<[RoleId, RoleId] | null>(null);
	toast = $state<string | null>(null);
	private toastToken = 0;

	/** Set when the host leaves and the server destroys the room out from
	 * under everyone still connected - the room page watches this and
	 * navigates away, since there's no state left here to keep rendering. */
	roomClosed = $state(false);
	/** The RoomClosed message, captured separately from the auto-expiring
	 * `toast` (which could clear itself, or be overwritten by something else,
	 * before the room page gets around to showing the blocking alert). */
	roomClosedMessage = $state<string | null>(null);

	/** Positive "you did X" confirmation, separate from `toast` (which is
	 * red/error-styled) - rendered at the room-page level rather than inside
	 * NightActionPrompt/VoteBoard/HunterShotPrompt, so it stays visible for its
	 * full duration even if the server advances the game (and unmounts one of
	 * those components) before the timer finishes. */
	confirmToast = $state<string | null>(null);
	private confirmToken = 0;

	/** Chronological, per-player diary: own submitted actions, own private
	 * results, and public outcomes - unlike lastNightDeaths/etc above (which
	 * hold only the latest occurrence), this accumulates for the whole game
	 * and is only cleared on a real reset (see resetPrivateState/applyState). */
	activityLog = $state<ActivityLogEntry[]>([]);

	/** Room-wide system log (who left, host destroyed the room, etc.) -
	 * distinct from activityLog above, which is one player's own actions.
	 * Deliberately NOT cleared by resetPrivateState/GameReset - the whole
	 * point is that a leave/close notice stays available to check even after
	 * the toast fades or a reshuffle clears it. Only cleared in applyState's
	 * isNewRoom branch, i.e. when actually switching to a different room. */
	roomLog = $state<RoomLogEntry[]>([]);

	/** Shows a confirmation banner for `ms`, then clears it - guarded by a
	 * token so a stale timer from an earlier call can never clear a *newer*
	 * confirmation that superseded it before the first one's timer fired. */
	showConfirm(text: string, ms = 3000): void {
		this.confirmToast = text;
		const token = ++this.confirmToken;
		setTimeout(() => {
			if (this.confirmToken === token) this.confirmToast = null;
		}, ms);
	}

	/** Same token-guarded auto-clear as showConfirm, for the red/error toast -
	 * without this it only ever got cleared by the next unrelated toast or a
	 * full reset, so e.g. a leave notification could linger through a
	 * subsequent reshuffle. */
	showToast(text: string, ms = 5000): void {
		this.toast = text;
		const token = ++this.toastToken;
		setTimeout(() => {
			if (this.toastToken === token) this.toast = null;
		}, ms);
	}

	/** Same token-guarded auto-clear as showConfirm/showToast, for the
	 * centered infoPopup. */
	showInfoPopup(message: string, tone: 'good' | 'bad' | 'neutral' = 'neutral', ms = 3000): void {
		this.infoPopup = { message, tone };
		const token = ++this.infoPopupToken;
		setTimeout(() => {
			if (this.infoPopupToken === token) this.infoPopup = null;
		}, ms);
	}

	/** Lets the popup be dismissed early (tapping the backdrop) instead of
	 * always waiting out its auto-close timer. */
	dismissInfoPopup(): void {
		this.infoPopup = null;
	}

	logRoom(line: LogLine): void {
		this.roomLog = [...this.roomLog, { round: this.currentRound(), line }];
	}

	/** Promotes a pending night-turn to active (myTurnRole/turnContext),
	 * called either by a real StageNarrationStarted signal or the fallback
	 * timer armed alongside pendingTurnRole - guarded so a stale call (the
	 * stage already moved on, or this turn was already revealed) is a no-op. */
	/** Promotes the pending night-turn to active. No role parameter needed:
	 * StageNarrationStarted no longer carries one (S4) - pendingTurnRole is
	 * already unique to whichever client actually has the current turn (reset
	 * to null on every StageChanged, set only by that client's own private
	 * YourTurnPrompt), so "am I pending on anything at all" is the only check
	 * that was ever actually doing the work here. */
	private revealTurn(): void {
		if (this.pendingTurnRole === null) return;
		this.myTurnRole = this.pendingTurnRole;
		this.turnContext = this.pendingTurnContext;
	}

	/** Bumped per turn prompt and per stage change - see YourTurnPrompt. */
	private turnToken = 0;

	private unsubscribers: (() => void)[] = [];

	private currentRound(): Round {
		const phase = this.state?.phase;
		return { group: phase ? phaseGroup(phase) : null, n: this.state?.nightNumber ?? 0 };
	}

	// --- This phone's view: what it may see and do right now -------------
	// Plain getters over $state fields: reactive wherever a component reads
	// them, and plain values in a test.

	/** This phone's seat, or null if it isn't seated. */
	get mySeat(): number | null {
		const me = this.viewerSessionId;
		if (!me) return null;
		return this.state?.seats.find((s) => s.sessionId === me)?.seatNumber ?? null;
	}

	get isHost(): boolean {
		return !!this.viewerSessionId && this.state?.hostSessionId === this.viewerSessionId;
	}

	/** The Host's 强制继续 button: on every night stage, so a phone that died
	 * mid-turn can never freeze the night - and its presence says nothing
	 * about which stage it is. */
	get needsHostAdvance(): boolean {
		return this.isHost && this.hostStage !== null;
	}

	/** The night is resolved but the Host hasn't announced it yet (DAWN):
	 * the deaths stay out of every view until 公布. */
	get awaitingNightAnnounce(): boolean {
		return this.state?.phase === 'DAWN';
	}

	/** The game's day/night rhythm, for tinting the page. */
	get timeOfDay(): TimeOfDay {
		const s = this.state;
		switch (s && phaseGroup(s.phase)) {
			case 'night':
				return 'night';
			case 'speech':
			case 'vote':
			case 'hunter':
				return 'day';
			case 'over':
				return s?.winner ?? 'villagers';
			default:
				return 'neutral';
		}
	}

	/** The vote board for this phone. S11: only WHO has voted is known, never
	 * for whom. §9.4: in a PK re-vote only the tied seats can be voted for,
	 * and they don't vote themselves. */
	get voteView(): VoteView {
		const s = this.state;
		const seats = s?.seats ?? [];
		const pk = s?.pkCandidates ?? [];
		const mySeat = this.mySeat;
		const me = seats.find((x) => x.seatNumber === mySeat);
		const alreadyVoted = mySeat !== null && (s?.votedSeats ?? []).includes(mySeat);
		const revealedIdiot = !!me?.revealedIdiot;
		const pkCandidate = mySeat !== null && pk.includes(mySeat);
		return {
			inPk: pk.length > 0,
			targets: seats.filter(
				(x) => x.sessionId !== null && !x.isDead && (pk.length === 0 || pk.includes(x.seatNumber))
			),
			votedCount: s?.votedSeats.length ?? 0,
			totalVoters: s?.totalVoters ?? 0,
			alreadyVoted,
			revealedIdiot,
			pkCandidate,
			canVote: !!me && !me.isDead && !revealedIdiot && !alreadyVoted && !pkCandidate
		};
	}

	/** The rules of this phone's current night turn, from its private
	 * TurnContext. UX only - the server enforces every one of them too. */
	get turnRules(): TurnRules {
		const ctx = this.turnContext;
		const witch = ctx?.witch;
		const killedSeat = witch?.killedSeat ?? null;
		const packTurn = ctx?.packKill === true;
		const role = this.myTurnRole;
		return {
			packTurn,
			killedSeat,
			guardLastSeat: ctx?.guard?.lastProtectedSeat ?? null,
			wolfTeammates: ctx?.wolf?.teammateSeats ?? [],
			// The witch was the one attacked tonight and tonight's rules don't
			// let her save herself (selfRescue is often FIRST_NIGHT_ONLY).
			isSelfKill: killedSeat !== null && killedSeat === ctx?.seat && !witch?.selfRescueAllowed,
			// Checking or idolising yourself makes no sense; the pack's kill
			// turn keeps every seat.
			noSelfPick: !packTurn && (role === 'SEER' || role === 'WILD_CHILD'),
			onePotionOnly: !witch?.bothPotionsSameNight
		};
	}

	/** A line everyone at the table learned: into the diary (marked public)
	 * and the room log. */
	private logPublic(line: LogLine): void {
		this.logActivity(line, { public: true });
		this.logRoom(line);
	}

	logActivity(line: LogLine, opts?: { public?: boolean }): void {
		this.activityLog = [
			...this.activityLog,
			{ round: this.currentRound(), line, public: opts?.public ?? false }
		];
		const s = this.state;
		if (s?.gameId) saveDiary(s.roomCode, s.gameId, this.activityLog);
	}

	/** Called synchronously at the very top of the room page's onMount, before
	 * anything (including the room-closed effect) can read stale data left
	 * over from whatever room was visited last - SPA navigation between rooms
	 * never tears this singleton down, and the async RoomJoin/applyState
	 * reset runs too late to stop an effect from firing on the stale value
	 * first (e.g. a room-closed alert reappearing for a brand new room). */
	resetForRoomVisit(): void {
		this.state = null;
		this.roomClosed = false;
		this.roomClosedMessage = null;
	}

	connect(): void {
		this.disconnect();
		onActionError((code) => this.showInfoPopup(formatActionError(code, i18n.lang), 'bad', 4000));
		this.unsubscribers.push(
			onServerEvent((event) => this.applyServerEvent(event)),
			onPrivateEvent((event) => this.applyPrivateEvent(event))
		);
	}

	disconnect(): void {
		for (const unsub of this.unsubscribers) unsub();
		this.unsubscribers = [];
	}

	/** Applies a full state snapshot - shared by the `StateSnapshot` broadcast
	 * event and by callers that received a `state` field directly in an
	 * action's ack response (e.g. `RoomJoin`/`ResyncRequest`), which is never
	 * also re-broadcast as a `StateSnapshot` event since it's only relevant
	 * to the one resyncing client.
	 *
	 * Only clears the private per-room fields (myRole, thiefChoice, etc.) when
	 * the room code itself changes - a resync/reconnect within the SAME room
	 * must NOT wipe a role that was just privately replayed (see RoomJoin's
	 * getRevealedRoleIfAny), since that private event can arrive just before
	 * this snapshot does. */
	applyState(state: RoomPublicState): void {
		const isNewRoom = this.state?.roomCode !== state.roomCode;
		this.state = state;
		if (isNewRoom) {
			// Everything resetPrivateState clears (lastNightDeaths/lastDayResult/
			// myRole/etc.) is exactly as stale as it would be on a same-room
			// GameReset - see that method's own comment. roomLog is the one
			// thing it deliberately leaves alone, since a genuinely different
			// room has no relationship to the old one's log at all.
			this.resetPrivateState();
			this.roomLog = [];
			// A reload mid-game: bring back this phone's diary for this game.
			if (state.gameId) this.activityLog = loadDiary(state.roomCode, state.gameId);
		}
		// Present only when this snapshot was addressed to the host's own
		// session (see getPublicState's forSessionId) - undefined for everyone
		// else, which correctly resolves to "no host-only stage info here".
		// Set after the reset above, which would otherwise wipe it on the
		// first snapshot of a room (every page load).
		this.hostStage = state.hostStage ?? null;
	}

	/** Wipes every transient per-round field. Used both when a host
	 * stop-and-restart (`GameReset`) resets the room back to SEATING without
	 * changing its room code, and by `applyState` when the room code DOES
	 * change - either way, all of this is equally stale. */
	resetPrivateState(): void {
		this.lastNightDeaths = null;
		this.lastDayResult = null;
		this.lastHunterResult = null;
		this.gameOverResult = null;
		this.myRole = null;
		this.myTurnRole = null;
		this.turnContext = null;
		this.hostStage = null;
		this.lastSeerResult = null;
		this.myPartnerSeat = null;
		this.pendingTurnRole = null;
		this.pendingTurnContext = null;
		this.hunterAuthorized = false;
		this.infoPopup = null;
		this.thiefChoice = null;
		this.toast = null;
		this.confirmToast = null;
		this.activityLog = [];
		this.roomClosed = false;
		this.roomClosedMessage = null;
	}

	/** Applies one room-wide event (also the socket subscription target). */
	applyServerEvent(event: ServerEvent): void {
		if (event.kind === 'StateSnapshot') {
			this.applyState(event.state);
			return;
		}
		if (!this.state) return;

		switch (event.kind) {
			case 'SeatUpdated':
				this.state = { ...this.state, seats: event.seats };
				break;
			case 'LockUpdated':
				this.state = { ...this.state, lockStatus: event.locked };
				break;
			case 'RolesRerolled':
				this.myRole = null;
				// Explicit clear on top of showToast's own auto-expiry - a
				// reshuffle should dismiss any lingering system toast right away,
				// not just whenever its timer happens to run out.
				this.toast = null;
				// Broadcast to every client (not just the host who clicked it) -
				// everyone's identity just changed, so everyone gets the
				// confirmation and the permanent room-log record of it.
				this.logRoom(logLine('rolesReshuffled', event.reason));
				this.showConfirm(
					event.reason
						? formatRolesReshuffled(i18n.lang, event.reason)
						: formatRolesReshuffledConfirm(i18n.lang),
					3000
				);
				break;
			case 'GameReset':
				this.resetPrivateState();
				break;
			case 'PhaseChanged':
				// Deliberately does NOT clear lastNightDeaths/lastDayResult/lastHunterResult
				// here - those events fire immediately before this one as part of the same
				// server-side transition, so clearing on PhaseChanged would make the result
				// banner flash and vanish before anyone could read it. They persist as "last
				// known result" until overwritten by the next occurrence of that event.
				this.state = {
					...this.state,
					phase: event.phase,
					nightNumber: event.nightNumber,
					currentSpeaker: null,
					speechOrder: [],
					// A new night clears it; a day-time hunter shot returning to the
					// day must not.
					dayDecided: phaseGroup(event.phase) === 'night' ? false : this.state.dayDecided
				};
				this.myTurnRole = null;
				this.turnContext = null;
				// A new phase means a new night's checks - the seer's last result
				// shouldn't carry across (it does survive StageChanged, below).
				this.lastSeerResult = null;
				this.pendingTurnRole = null;
				this.pendingTurnContext = null;
				break;
			case 'StageChanged':
				this.turnToken++;
				this.state = { ...this.state, stage: event.stage };
				this.stageConfirmed = false;
				this.coupleConfirmed = false;
				this.packKill = null;
				this.roleDoneByOther = false;
				this.myTurnRole = null;
				this.turnContext = null;
				this.pendingTurnRole = null;
				this.pendingTurnContext = null;
				break;
			case 'NightResolved':
				this.lastNightDeaths = event.deaths;
				this.logPublic(logLine('nightDeaths', event.deaths));
				break;
			case 'DeathsUpdated': {
				this.state = {
					...this.state,
					deadSeats: event.deadSeats,
					seats: this.state.seats.map((s) => ({
						...s,
						isDead: event.deadSeats.includes(s.seatNumber),
						...(event.revealedIdiots.includes(s.seatNumber) ? { revealedIdiot: true } : {})
					}))
				};
				break;
			}
			case 'DayDecided':
				this.state = { ...this.state, dayDecided: true };
				break;
			case 'VoteUpdated':
				this.state = {
					...this.state,
					votedSeats: event.votedSeats,
					totalVoters: event.totalVoters
				};
				break;
			case 'DayResolved':
				this.lastDayResult = {
					eliminatedSeat: event.eliminatedSeat,
					identity: event.identity,
					tie: event.tie,
					followDeathSeat: event.followDeathSeat,
					followDeathIdentity: event.followDeathIdentity,
					idiotRevealed: event.idiotRevealed === true
				};
				this.state = { ...this.state, pkCandidates: event.pkCandidates ?? [] };
				this.logPublic(
					logLine('dayResult', {
						tie: event.tie,
						eliminatedSeat: event.eliminatedSeat,
						identity: event.identity,
						followDeathSeat: event.followDeathSeat,
						idiotRevealed: event.idiotRevealed === true
					})
				);
				break;
			case 'LastWordsSpeakerChanged':
				this.state = { ...this.state, currentSpeaker: event.seat };
				break;
			case 'DiscussionSpeakerChanged':
				this.state = { ...this.state, currentSpeaker: event.seat, speechOrder: event.order };
				break;
			case 'DayOut': {
				this.logPublic(logLine('dayOut', event.seats, event.followDeaths));
				break;
			}
			case 'SelfExploded': {
				this.logPublic(logLine('selfExplode', event.seat));
				break;
			}
			case 'KnightDuelResolved': {
				this.logPublic(
					logLine('knightDuel', event.knightSeat, event.targetSeat, event.targetWasWolf)
				);
				this.state = { ...this.state, knightUsed: true };
				break;
			}
			case 'HunterPending':
				this.state = { ...this.state, hunterSeat: event.hunterSeat };
				break;
			case 'HunterResolved':
				this.lastHunterResult = {
					hunterSeat: event.hunterSeat,
					shotSeat: event.shotSeat,
					followDeathSeat: event.followDeathSeat
				};
				this.hunterAuthorized = false;
				this.state = { ...this.state, hunterSeat: null };
				this.logPublic(
					logLine('hunterResult', {
						hunterSeat: event.hunterSeat,
						shotSeat: event.shotSeat,
						followDeathSeat: event.followDeathSeat
					})
				);
				break;
			case 'GameOver':
				this.gameOverResult = {
					winner: event.winner,
					identities: event.identities,
					coupleSeats: event.coupleSeats
				};
				this.state = {
					...this.state,
					phase: 'GAME_OVER',
					winner: event.winner,
					identities: event.identities
				};
				this.logPublic(logLine('gameOver', event.winner));
				break;
			case 'ErrorToast': {
				this.logRoom(logLine('playerLeftMidGame', event.seat));
				this.showToast(formatPlayerLeftMidGame(event.seat, i18n.lang));
				break;
			}
			case 'RoomClosed': {
				const text = formatRoomClosedByHost(i18n.lang);
				this.logRoom(logLine('roomClosedByHost'));
				this.showToast(text);
				this.roomClosedMessage = text;
				this.roomClosed = true;
				break;
			}
			case 'StageNarrationStarted':
				this.revealTurn();
				break;
			case 'HostOverrideApplied': {
				this.logPublic(logLine('hostOverride', event.seat, event.overrideKind));
				break;
			}
		}
	}

	/** Applies one event private to this phone. */
	applyPrivateEvent(event: PrivateInfo): void {
		switch (event.kind) {
			case 'YourRole':
				// 上帝之手 changed this card mid-turn: drop a prompt that belongs
				// to the old role (a new one, if any, follows right behind).
				if (this.myRole !== null && this.myRole !== event.role) {
					this.myTurnRole = null;
					this.turnContext = null;
					this.pendingTurnRole = null;
					this.pendingTurnContext = null;
				}
				this.myRole = event.role;
				break;
			case 'StageConfirmed':
				this.stageConfirmed = true;
				break;
			case 'RoleChangedByHost': {
				if (event.forYou) {
					this.logActivity(logLine('text', 'nightPrompt', 'roleChangedForYou'));
					this.showInfoPopup(strings(i18n.lang).nightPrompt.roleChangedForYou, 'neutral', 6000);
				} else {
					this.logActivity(logLine('hostOverride', event.seat, 'SET_ROLE'));
				}
				break;
			}
			case 'RoleDoneByOther': {
				this.roleDoneByOther = true;
				this.logActivity(logLine('text', 'nightPrompt', 'roleDoneByOther'));
				this.showInfoPopup(strings(i18n.lang).nightPrompt.roleDoneByOther, 'neutral', 5000);
				break;
			}
			case 'PackKillChosen': {
				this.packKill = { bySeat: event.bySeat, target: event.target };
				this.logActivity(
					logLine('text', 'nightPrompt', 'packKillChosen', event.bySeat, event.target)
				);
				this.showInfoPopup(
					strings(i18n.lang).nightPrompt.packKillChosen(event.bySeat, event.target),
					'neutral',
					5000
				);
				break;
			}
			case 'SeerResult':
				this.lastSeerResult = { targetSeat: event.targetSeat, isWolf: event.isWolf };
				// '坏人'/'好人', not the specific role - the seer only ever learns
				// good/bad (isWolf is the only thing the server ever sends), so the
				// wording shouldn't imply anything more specific than that either.
				this.logActivity(logLine('seerResult', event.targetSeat, event.isWolf));
				// lastSeerResult above is the lasting record (shown inline in the
				// prompt/activity log) - the popup is just the "here's the answer"
				// moment, same treatment as the role-reveal card.
				this.showInfoPopup(
					strings(i18n.lang).nightPrompt.checkResult(event.targetSeat, event.isWolf),
					event.isWolf ? 'bad' : 'good'
				);
				break;
			case 'CoupleRevealed':
				this.logActivity(logLine('coupleRevealed', event.partnerSeat));
				// Held for the COUPLE_REVEAL stage's own reveal button, not shown
				// right away - see myPartnerSeat's own comment.
				this.myPartnerSeat = event.partnerSeat;
				break;
			case 'ThiefChoice':
				this.thiefChoice = event.buried;
				break;
			case 'YourTurnPrompt': {
				const role = event.role;
				this.pendingTurnRole = role;
				this.pendingTurnContext = event.context;
				if (event.replay) {
					// Re-sent after a reconnect/reload (server's turnReplay.ts) -
					// this stage's narration already played while we were away, so
					// there's no StageNarrationStarted left to wait for.
					this.revealTurn();
					break;
				}
				// Fallback in case narration never relays a start signal (muted,
				// unsupported browser, no host connected) - see revealTurn. Tied
				// to this turn: a player with two turns in a row (狼美人, 黑狼王
				// after the pack) must not have the first turn's timer reveal
				// the second before its call-out.
				const token = ++this.turnToken;
				setTimeout(() => {
					if (token === this.turnToken) this.revealTurn();
				}, TURN_REVEAL_FALLBACK_MS);
				break;
			}
			case 'HunterAuthorized':
				this.hunterAuthorized = true;
				this.showInfoPopup(formatHunterAuthorized(i18n.lang), 'good');
				break;
			case 'ShotStatus': {
				this.logActivity(logLine('shotStatus', event.canShoot));
				this.showInfoPopup(
					formatShotStatus(event.canShoot, i18n.lang),
					event.canShoot ? 'good' : 'bad',
					8000
				);
				break;
			}
			case 'HunterDenied':
				this.logActivity(logLine('hunterDenied'));
				this.showInfoPopup(formatHunterDenied(i18n.lang), 'bad');
				break;
			case 'HostStageChanged':
				this.hostStage = event.stage;
				break;
			case 'NightActionAck':
				// Host-only (S4) - nothing reads this yet; kept for a possible
				// future host-side "who's acted" checklist.
				break;
		}
	}
}

export const gameStore = new GameStore();
