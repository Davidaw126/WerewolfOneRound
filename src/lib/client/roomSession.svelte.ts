// The phone's side of being in a Room: entering it (one round trip, from
// the lobby or on a page reload), staying in step with it across a dropped
// connection or a trip to the background, and finding out it's no longer in
// it - the room closed, this player left on another phone, or the server no
// longer counts this session in the room. Pages only draw: the lobby calls
// `create`/`enter`, the room page `open`/`close`/`leave` and watches `out`.
//
// It talks to the server through a RoomTransport: the real socket (below)
// or a fake one in tests (roomSession.spec.ts).

import type {
	ActionReply,
	ClientAction,
	PrivateInfo,
	ServerEvent,
	AckResponse
} from '$lib/shared/events';
import type { RoomPublicState } from '$lib/shared/gameTypes';
import { gameStore, type GameStore } from './gameStore.svelte';
import { getSocket, sendAction, onServerEvent, onPrivateEvent, onActionError } from './socket';
import { formatRefusal } from '$lib/shared/i18n';
import { i18n } from './i18n.svelte';

export interface RoomTransport {
	/** Sends an action. `quiet`: no error popup - the caller deals with a
	 * refusal itself. */
	send<A extends ClientAction>(
		action: A,
		opts?: { quiet?: boolean }
	): Promise<ActionReply<A['kind']>>;
	onServerEvent(handler: (event: ServerEvent) => void): () => void;
	onPrivateEvent(handler: (event: PrivateInfo) => void): () => void;
	/** The connection came back after a drop (not the first connect). */
	onReconnect(handler: () => void): () => void;
	/** The page came back to the foreground. */
	onForeground(handler: () => void): () => void;
	/** Drops the connection and opens a fresh one; resolves once connected. */
	restart(): Promise<void>;
}

/** Why this phone is out of the room. */
export type OutReason =
	/** The Host left: the room is closed. */
	| 'host_left'
	/** The room isn't there any more (it expired). */
	| 'room_gone'
	/** This player left the room on another phone or tab. */
	| 'left_elsewhere'
	/** The server no longer counts this session in the room. */
	| 'removed';

export class RoomSession {
	/** The room this phone is in, once entered. */
	code = $state<string | null>(null);
	/** Set once this phone is out of the room; the room page shows why and
	 * goes back to the lobby. */
	out = $state<OutReason | null>(null);

	private leaving = false;
	/** Private events arriving while a catch-up is on its way: held until its
	 * answer has been applied, so that answer can tell what's still owed. */
	private held: PrivateInfo[] | null = null;
	private catchingUp: Promise<void> | null = null;
	private listeners: (() => void)[] = [];
	private watchers: (() => void)[] = [];

	constructor(
		private readonly store: GameStore,
		private readonly transport: RoomTransport
	) {}

	/** Opens a new room as its Host. */
	async create(): Promise<ActionReply<'RoomCreate'>> {
		this.reset();
		this.listen();
		const reply = await this.transport.send({ kind: 'RoomCreate' }, { quiet: true });
		if (reply.ok) this.entered(reply.roomCode, reply.state);
		return reply;
	}

	/** Enters a room - from the lobby, or on a page reload. */
	async enter(code: string): Promise<ActionReply<'RoomJoin'>> {
		this.reset();
		this.listen();
		this.held = [];
		const reply = await this.transport.send({ kind: 'RoomJoin', roomCode: code }, { quiet: true });
		const owed = this.held ?? [];
		this.held = null;
		if (reply.ok) {
			this.code = code;
			this.store.applyCatchUp(reply.state, owed);
		}
		return reply;
	}

	/** The room page is up: keeps it in step from here on. Enters only if
	 * the lobby hasn't just done so - a reload or a shared link. Answers
	 * whether this phone is in the room. */
	async open(code: string, viewerSessionId: string): Promise<boolean> {
		this.store.viewerSessionId = viewerSessionId;
		const inRoom =
			(this.code === code && this.store.state?.roomCode === code) || (await this.enter(code)).ok;
		if (inRoom) this.watch();
		return inRoom;
	}

	/** The room page is going away. */
	close(): void {
		for (const off of [...this.listeners, ...this.watchers]) off();
		this.listeners = [];
		this.watchers = [];
		this.code = null;
	}

	/** Leave (see GLOSSARY.md). This phone's own leave isn't news to it. */
	async leave(): Promise<AckResponse> {
		this.leaving = true;
		const reply = await this.transport.send({ kind: 'RoomLeave' });
		if (!reply.ok) this.leaving = false;
		return reply;
	}

	/** Catches up after a gap: the room as it is now, and anything private
	 * this phone is owed (its role, a turn prompt it missed). */
	resync(): Promise<void> {
		// One at a time: a reconnect and coming back to the foreground usually
		// land together.
		this.catchingUp ??= this.catchUp().finally(() => (this.catchingUp = null));
		return this.catchingUp;
	}

	private async catchUp(): Promise<void> {
		if (!this.code || this.out) return;
		const code = this.code;
		this.held = [];
		let reply = await this.transport.send({ kind: 'ResyncRequest' }, { quiet: true });
		// No answer at all: after the screen was locked, iOS can leave a
		// socket that still says "connected" but is dead, and socket.io only
		// notices on its next missed ping (up to ~45s) - long enough to sit
		// out a whole night turn. Start a fresh connection and ask again.
		if (!reply.ok && reply.error === 'timeout') {
			await this.transport.restart();
			if (this.code !== code || this.out) return;
			reply = await this.transport.send({ kind: 'ResyncRequest' }, { quiet: true });
		}
		// Left or moved on while waiting: the answer is for a page that's gone.
		if (this.code !== code) return;
		const owed = this.held ?? [];
		this.held = null;
		if (reply.ok) this.store.applyCatchUp(reply.state, owed);
		else {
			for (const event of owed) this.store.applyPrivateEvent(event);
			if (reply.error === 'not_in_room') this.goOut('removed');
			else if (reply.error === 'room_not_found') this.goOut('room_gone');
		}
	}

	private reset(): void {
		this.close();
		this.held = null;
		this.out = null;
		this.leaving = false;
		this.store.resetForRoomVisit();
	}

	private entered(code: string, state: RoomPublicState): void {
		this.code = code;
		this.store.applyState(state);
	}

	private goOut(reason: OutReason): void {
		if (this.out || this.leaving) return;
		this.out = reason;
	}

	/** Room events go to the store; the ones that put this phone out are
	 * also noticed here. */
	private listen(): void {
		if (this.listeners.length > 0) return;
		this.listeners.push(
			this.transport.onServerEvent((event) => {
				// Another room's news - one this phone walked away from without
				// leaving - must not take over this room's page.
				if (event.kind === 'StateSnapshot' && this.code && event.state.roomCode !== this.code)
					return;
				this.dropOutdatedHeld(event);
				this.store.applyServerEvent(event);
				if (event.kind === 'RoomClosed') this.goOut('host_left');
			}),
			this.transport.onPrivateEvent((event) => {
				if (event.kind === 'RemovedFromRoom') this.goOut('left_elsewhere');
				else if (this.held) this.held.push(event);
				else this.store.applyPrivateEvent(event);
			})
		);
	}

	/** What a catch-up sent before this news arrived mustn't be applied after
	 * it: the card just re-dealt, the turn just ended, the game just stopped. */
	private dropOutdatedHeld(event: ServerEvent): void {
		if (!this.held) return;
		if (event.kind === 'GameReset') this.held = [];
		if (event.kind === 'RolesRerolled') this.held = this.held.filter((e) => e.kind !== 'YourRole');
		if (event.kind === 'StageChanged' || event.kind === 'PhaseChanged') {
			this.held = this.held.filter(
				(e) => e.kind !== 'StageConfirmed' && !(e.kind === 'YourTurnPrompt' && e.replay)
			);
		}
	}

	/** Resync whenever this phone may have missed something. */
	private watch(): void {
		this.listen();
		if (this.watchers.length > 0) return;
		const resync = () => void this.resync();
		this.watchers.push(this.transport.onReconnect(resync), this.transport.onForeground(resync));
	}
}

const RESTART_WAIT_MS = 10_000;

/** The real transport: the app's one socket.io connection and the page's
 * visibility. */
const socketTransport: RoomTransport = {
	send: sendAction,
	onServerEvent,
	onPrivateEvent,
	restart() {
		const socket = getSocket();
		return new Promise((resolve) => {
			// A connect we ask for ourselves isn't a socket.io 'reconnect', so
			// onReconnect's resync doesn't run a second time.
			socket.once('connect', () => resolve());
			// No network yet: stop waiting, so the catch-up can report it and
			// release the private events it's holding. The next reconnect
			// catches up again.
			setTimeout(resolve, RESTART_WAIT_MS);
			socket.disconnect().connect();
		});
	},
	onReconnect(handler) {
		const socket = getSocket();
		// socket.io fires 'connect' again on every reconnect; the first
		// connect is the page's own `enter`.
		const onConnect = () => handler();
		socket.io.on('reconnect', onConnect);
		return () => socket.io.off('reconnect', onConnect);
	},
	onForeground(handler) {
		// iOS Safari can leave a socket that still says "connected" after the
		// screen was locked but missed everything meanwhile - most of all a
		// one-shot turn prompt.
		const onVisible = () => {
			if (!document.hidden) handler();
		};
		document.addEventListener('visibilitychange', onVisible);
		window.addEventListener('pageshow', onVisible);
		return () => {
			document.removeEventListener('visibilitychange', onVisible);
			window.removeEventListener('pageshow', onVisible);
		};
	}
};

export const roomSession = new RoomSession(gameStore, socketTransport);

// A refused action someone tapped pops up with the reason, wherever it was
// sent from - never a tap that silently does nothing.
onActionError((refusal) => {
	// The tap's answer got lost and it went through the first time: the
	// prompt just closes (see NightActionPrompt), there's nothing to report.
	if (refusal.error === 'already_submitted') return;
	gameStore.showInfoPopup(formatRefusal(refusal, i18n.lang), 'bad', 4000);
});
