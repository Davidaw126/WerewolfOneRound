import type { NightStage, RoomPublicState, Winner } from '$lib/shared/gameTypes';
import type { Role } from '$lib/shared/roles';
import type { ServerEvent, PrivateInfo, TurnContext } from '$lib/shared/events';
import { onServerEvent, onPrivateEvent } from './socket';
import { i18n } from './i18n.svelte';
import {
	strings,
	formatNightDeaths,
	formatDayResult,
	formatHunterResult,
	formatGameOverText,
	formatSelfExplode,
	formatKnightDuel,
	formatHostOverrideApplied,
	formatSeerResult,
	formatCoupleRevealed,
	formatRolesReshuffled,
	formatRolesReshuffledConfirm,
	formatHunterDenied,
	formatHunterAuthorized,
	formatRoomClosedByHost,
	formatPlayerLeftMidGame
} from '$lib/shared/i18n';

export interface ActivityLogEntry {
	round: string;
	text: string;
	public: boolean;
}

export interface RoomLogEntry {
	round: string;
	text: string;
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
class GameStore {
	state = $state<RoomPublicState | null>(null);
	/** Host-only, and only ever non-null on the host's own client - the real
	 * current stage (role included), fed by StateSnapshot's hostStage and kept
	 * live by HostStageChanged. Everyone's shared `state.stage` is role-redacted
	 * (S4) - JudgeAudioPlayer reads this instead. */
	hostStage = $state<NightStage | null>(null);

	lastNightDeaths = $state<number[] | null>(null);
	lastDayResult = $state<{
		eliminatedSeat: number | null;
		identity: Role | null;
		tie: boolean;
		followDeathSeat: number | null;
		followDeathIdentity: Role | null;
	} | null>(null);
	lastHunterResult = $state<{
		hunterSeat: number;
		shotSeat: number | null;
		followDeathSeat: number | null;
	} | null>(null);
	gameOverResult = $state<{
		winner: Winner;
		identities: Record<number, Role>;
		coupleSeats: [number, number] | null;
	} | null>(null);

	myRole = $state<Role | null>(null);
	myTurnRole = $state<Role | null>(null);
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
	pendingTurnRole = $state<Role | null>(null);
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
	thiefChoice = $state<[Role, Role] | null>(null);
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

	logRoom(text: string): void {
		this.roomLog = [...this.roomLog, { round: this.roundLabel(), text }];
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

	private unsubscribers: (() => void)[] = [];

	private roundLabel(): string {
		const phase = this.state?.phase;
		const night = this.state?.nightNumber ?? 0;
		const t = strings(i18n.lang).phaseBanner;
		switch (phase) {
			case 'NIGHT_ACTIONS':
			case 'NIGHT_HUNTER_SHOT':
				return t.night(night);
			case 'DAY_VOTE':
			case 'DAY_HUNTER_SHOT':
				return i18n.lang === 'zh' ? `第 ${night} 天` : `Day ${night}`;
			case 'GAME_OVER':
				return t.gameOver;
			default:
				return '';
		}
	}

	logActivity(text: string, opts?: { public?: boolean }): void {
		this.activityLog = [
			...this.activityLog,
			{ round: this.roundLabel(), text, public: opts?.public ?? false }
		];
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
		this.unsubscribers.push(
			onServerEvent((event) => this.handleServerEvent(event)),
			onPrivateEvent((event) => this.handlePrivateEvent(event))
		);
	}

	disconnect(): void {
		for (const unsub of this.unsubscribers) unsub();
		this.unsubscribers = [];
	}

	private markDead(seat: number): void {
		if (!this.state) return;
		if (this.state.deadSeats.includes(seat)) return;
		this.state = {
			...this.state,
			deadSeats: [...this.state.deadSeats, seat].sort((a, b) => a - b),
			seats: this.state.seats.map((s) => (s.seatNumber === seat ? { ...s, isDead: true } : s))
		};
	}

	/** M6 上帝之手 REVIVE only - every other death is permanent, so nothing
	 * else ever needs to undo markDead. */
	private markAlive(seat: number): void {
		if (!this.state) return;
		if (!this.state.deadSeats.includes(seat)) return;
		this.state = {
			...this.state,
			deadSeats: this.state.deadSeats.filter((s) => s !== seat),
			seats: this.state.seats.map((s) => (s.seatNumber === seat ? { ...s, isDead: false } : s))
		};
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
		// Present only when this snapshot was addressed to the host's own
		// session (see getPublicState's forSessionId) - undefined for everyone
		// else, which correctly resolves to "no host-only stage info here".
		this.hostStage = state.hostStage ?? null;
		if (isNewRoom) {
			// Everything resetPrivateState clears (lastNightDeaths/lastDayResult/
			// myRole/etc.) is exactly as stale as it would be on a same-room
			// GameReset - see that method's own comment. roomLog is the one
			// thing it deliberately leaves alone, since a genuinely different
			// room has no relationship to the old one's log at all.
			this.resetPrivateState();
			this.roomLog = [];
		}
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

	private handleServerEvent(event: ServerEvent): void {
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
				this.logRoom(formatRolesReshuffled(i18n.lang));
				this.showConfirm(formatRolesReshuffledConfirm(i18n.lang), 3000);
				break;
			case 'NightAnnouncePending':
				this.state = { ...this.state, pendingNightAnnounce: true };
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
					speechOrder: []
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
				this.state = { ...this.state, stage: event.stage };
				this.myTurnRole = null;
				this.turnContext = null;
				this.pendingTurnRole = null;
				this.pendingTurnContext = null;
				break;
			case 'NightResolved':
				this.lastNightDeaths = event.deaths;
				this.state = { ...this.state, pendingNightAnnounce: false };
				for (const seat of event.deaths) this.markDead(seat);
				{
					const text = formatNightDeaths(event.deaths, i18n.lang);
					this.logActivity(text, { public: true });
					this.logRoom(text);
				}
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
					followDeathIdentity: event.followDeathIdentity
				};
				this.state = { ...this.state, pkCandidates: event.pkCandidates ?? [] };
				if (event.eliminatedSeat !== null) this.markDead(event.eliminatedSeat);
				if (event.followDeathSeat !== null) this.markDead(event.followDeathSeat);
				{
					const text = formatDayResult({
						tie: event.tie,
						eliminatedSeat: event.eliminatedSeat,
						identity: event.identity,
						followDeathSeat: event.followDeathSeat,
						lang: i18n.lang
					});
					this.logActivity(text, { public: true });
					this.logRoom(text);
				}
				break;
			case 'LastWordsSpeakerChanged':
				this.state = { ...this.state, currentSpeaker: event.seat };
				break;
			case 'DiscussionSpeakerChanged':
				this.state = { ...this.state, currentSpeaker: event.seat, speechOrder: event.order };
				break;
			case 'SelfExploded': {
				const text = formatSelfExplode(event.seat, i18n.lang);
				this.logActivity(text, { public: true });
				this.logRoom(text);
				this.markDead(event.seat);
				break;
			}
			case 'KnightDuelResolved': {
				const text = formatKnightDuel(
					event.knightSeat,
					event.targetSeat,
					event.targetWasWolf,
					i18n.lang
				);
				this.logActivity(text, { public: true });
				this.logRoom(text);
				this.markDead(event.targetWasWolf ? event.targetSeat : event.knightSeat);
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
				if (event.shotSeat !== null) this.markDead(event.shotSeat);
				if (event.followDeathSeat !== null) this.markDead(event.followDeathSeat);
				{
					const text = formatHunterResult({
						hunterSeat: event.hunterSeat,
						shotSeat: event.shotSeat,
						followDeathSeat: event.followDeathSeat,
						lang: i18n.lang
					});
					this.logActivity(text, { public: true });
					this.logRoom(text);
				}
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
				{
					const text = formatGameOverText(event.winner, i18n.lang, false);
					this.logActivity(text, { public: true });
					this.logRoom(text);
				}
				break;
			case 'ErrorToast': {
				const text = formatPlayerLeftMidGame(event.seat, i18n.lang);
				this.logRoom(text);
				this.showToast(text);
				break;
			}
			case 'RoomClosed': {
				const text = formatRoomClosedByHost(i18n.lang);
				this.logRoom(text);
				this.showToast(text);
				this.roomClosedMessage = text;
				this.roomClosed = true;
				break;
			}
			case 'StageNarrationStarted':
				this.revealTurn();
				break;
			case 'HostOverrideApplied': {
				if (event.overrideKind === 'KILL') this.markDead(event.seat);
				if (event.overrideKind === 'REVIVE') this.markAlive(event.seat);
				const text = formatHostOverrideApplied(event.seat, event.overrideKind, i18n.lang);
				this.logActivity(text, { public: true });
				this.logRoom(text);
				break;
			}
		}
	}

	private handlePrivateEvent(event: PrivateInfo): void {
		switch (event.kind) {
			case 'YourRole':
				this.myRole = event.role;
				break;
			case 'SeerResult':
				this.lastSeerResult = { targetSeat: event.targetSeat, isWolf: event.isWolf };
				// '坏人'/'好人', not the specific role - the seer only ever learns
				// good/bad (isWolf is the only thing the server ever sends), so the
				// wording shouldn't imply anything more specific than that either.
				this.logActivity(formatSeerResult(event.targetSeat, event.isWolf, i18n.lang));
				// lastSeerResult above is the lasting record (shown inline in the
				// prompt/activity log) - the popup is just the "here's the answer"
				// moment, same treatment as the role-reveal card.
				this.showInfoPopup(
					strings(i18n.lang).nightPrompt.checkResult(event.targetSeat, event.isWolf),
					event.isWolf ? 'bad' : 'good'
				);
				break;
			case 'CoupleRevealed':
				this.logActivity(formatCoupleRevealed(event.partnerSeat, i18n.lang));
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
				// Fallback in case narration never relays a start signal (muted,
				// unsupported browser, no host connected) - see revealTurn.
				setTimeout(() => this.revealTurn(), TURN_REVEAL_FALLBACK_MS);
				break;
			}
			case 'HunterAuthorized':
				this.hunterAuthorized = true;
				this.showInfoPopup(formatHunterAuthorized(i18n.lang), 'good');
				break;
			case 'HunterDenied':
				this.logActivity(formatHunterDenied(i18n.lang));
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
