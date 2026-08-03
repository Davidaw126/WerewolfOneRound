import type { RoomPublicState } from '$lib/shared/gameTypes';
import type { Role } from '$lib/shared/roles';
import type { ServerEvent, PrivateInfo, TurnContext } from '$lib/shared/events';
import { onServerEvent, onPrivateEvent } from './socket';

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

	lastNightDeaths = $state<number[] | null>(null);
	lastDayResult = $state<{
		eliminatedSeat: number | null;
		identity: Role | null;
		tie: boolean;
	} | null>(null);
	lastHunterResult = $state<{ hunterSeat: number; shotSeat: number | null } | null>(null);
	gameOverResult = $state<{
		winner: 'wolves' | 'villagers';
		identities: Record<number, Role>;
	} | null>(null);

	myRole = $state<Role | null>(null);
	myTurnRole = $state<Role | null>(null);
	/** Private per-turn info for whoever is acting - see TurnContext. */
	turnContext = $state<TurnContext | null>(null);
	/** The most recent 预言家 check result, mirrored out of the activity log so
	 * the prompt can show it inline (the log entry remains the lasting record).
	 * Deliberately NOT cleared on StageChanged. */
	lastSeerResult = $state<{ targetSeat: number; isWolf: boolean } | null>(null);

	/** Set by YourTurnPrompt the instant the server enters this role's turn -
	 * held back from myTurnRole/turnContext until a StageNarrationStarted
	 * (or the fallback timer) promotes it, so the prompt card doesn't appear
	 * before the role's own narration line has actually started. */
	pendingTurnRole = $state<Role | null>(null);
	pendingTurnContext = $state<TurnContext | null>(null);

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

	logRoom(text: string): void {
		this.roomLog = [...this.roomLog, { round: this.roundLabel(), text }];
	}

	/** Promotes a pending night-turn to active (myTurnRole/turnContext),
	 * called either by a real StageNarrationStarted signal or the fallback
	 * timer armed alongside pendingTurnRole - guarded so a stale call (the
	 * stage already moved on, or this turn was already revealed) is a no-op. */
	private revealTurn(role: Role): void {
		if (this.pendingTurnRole !== role) return;
		this.myTurnRole = role;
		this.turnContext = this.pendingTurnContext;
	}

	private unsubscribers: (() => void)[] = [];

	private roundLabel(): string {
		const phase = this.state?.phase;
		const night = this.state?.nightNumber ?? 0;
		switch (phase) {
			case 'NIGHT_ACTIONS':
			case 'NIGHT_HUNTER_SHOT':
				return `第 ${night} 夜`;
			case 'DAY_VOTE':
			case 'DAY_HUNTER_SHOT':
				return `第 ${night} 天`;
			case 'GAME_OVER':
				return '游戏结束';
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
			this.myRole = null;
			this.thiefChoice = null;
			this.gameOverResult = null;
			this.activityLog = [];
			this.roomClosed = false;
			this.roomClosedMessage = null;
			this.roomLog = [];
			// A toast (e.g. the host-destroyed-room notice) can still be within
			// its auto-clear window when a brand new room is created right after -
			// without this it would keep showing a stale message about the OLD
			// room on top of the new one.
			this.toast = null;
			this.confirmToast = null;
		}
	}

	/** Wipes every transient per-round field. Used when a host stop-and-restart
	 * (`GameReset`) resets the room back to SEATING without changing its room
	 * code - `applyState`'s isNewRoom check wouldn't fire for that, but all of
	 * this is just as stale as it would be after switching rooms entirely. */
	resetPrivateState(): void {
		this.lastNightDeaths = null;
		this.lastDayResult = null;
		this.lastHunterResult = null;
		this.gameOverResult = null;
		this.myRole = null;
		this.myTurnRole = null;
		this.turnContext = null;
		this.lastSeerResult = null;
		this.pendingTurnRole = null;
		this.pendingTurnContext = null;
		this.hunterAuthorized = false;
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
				this.logRoom('房主重新分配了角色');
				this.showConfirm('✓ 角色已重新分配', 3000);
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
				this.state = { ...this.state, phase: event.phase, nightNumber: event.nightNumber };
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
			case 'NightActionAck':
				break;
			case 'NightResolved':
				this.lastNightDeaths = event.deaths;
				this.state = { ...this.state, pendingNightAnnounce: false };
				for (const seat of event.deaths) this.markDead(seat);
				{
					const text =
						event.deaths.length === 0
							? '昨夜是平安夜'
							: `昨夜 ${event.deaths.join('、')} 号玩家死亡`;
					this.logActivity(text, { public: true });
					this.logRoom(text);
				}
				break;
			case 'VoteUpdated':
				this.state = { ...this.state, votes: event.votes };
				break;
			case 'DayResolved':
				this.lastDayResult = {
					eliminatedSeat: event.eliminatedSeat,
					identity: event.identity,
					tie: event.tie
				};
				if (event.eliminatedSeat !== null) this.markDead(event.eliminatedSeat);
				{
					const text = event.tie
						? '投票平票，无人出局'
						: event.eliminatedSeat === null
							? '本轮无人出局'
							: `${event.eliminatedSeat} 号被投票出局，身份是 ${event.identity}`;
					this.logActivity(text, { public: true });
					this.logRoom(text);
				}
				break;
			case 'HunterPending':
				this.state = { ...this.state, hunterSeat: event.hunterSeat };
				break;
			case 'HunterResolved':
				this.lastHunterResult = { hunterSeat: event.hunterSeat, shotSeat: event.shotSeat };
				this.hunterAuthorized = false;
				this.state = { ...this.state, hunterSeat: null };
				if (event.shotSeat !== null) this.markDead(event.shotSeat);
				{
					const text =
						event.shotSeat === null
							? `${event.hunterSeat} 号猎人选择不开枪`
							: `${event.hunterSeat} 号猎人开枪，带走了 ${event.shotSeat} 号`;
					this.logActivity(text, { public: true });
					this.logRoom(text);
				}
				break;
			case 'GameOver':
				this.gameOverResult = { winner: event.winner, identities: event.identities };
				this.state = {
					...this.state,
					phase: 'GAME_OVER',
					winner: event.winner,
					identities: event.identities
				};
				{
					const text = event.winner === 'wolves' ? '狼人阵营胜利' : '好人阵营胜利';
					this.logActivity(text, { public: true });
					this.logRoom(text);
				}
				break;
			case 'ErrorToast':
				this.logRoom(event.message);
				this.showToast(event.message);
				break;
			case 'RoomClosed':
				this.logRoom(event.message);
				this.showToast(event.message);
				this.roomClosedMessage = event.message;
				this.roomClosed = true;
				break;
			case 'StageNarrationStarted':
				this.revealTurn(event.role);
				break;
		}
	}

	private handlePrivateEvent(event: PrivateInfo): void {
		switch (event.kind) {
			case 'YourRole':
				this.myRole = event.role;
				break;
			case 'SeerResult':
				this.lastSeerResult = { targetSeat: event.targetSeat, isWolf: event.isWolf };
				this.logActivity(
					`你查验了 ${event.targetSeat} 号，结果是${event.isWolf ? '狼人' : '好人'}`
				);
				break;
			case 'CoupleRevealed':
				this.logActivity(`你的情侣是 ${event.partnerSeat} 号`);
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
				setTimeout(() => this.revealTurn(role), TURN_REVEAL_FALLBACK_MS);
				break;
			}
			case 'HunterAuthorized':
				this.hunterAuthorized = true;
				break;
			case 'HunterDenied':
				this.showToast('你身中剧毒，无法开枪反击');
				this.logActivity('你身中剧毒，无法开枪反击');
				break;
		}
	}
}

export const gameStore = new GameStore();
