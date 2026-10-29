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
		const reply = await this.transport.send({ kind: 'RoomJoin', roomCode: code }, { quiet: true });
		if (reply.ok) this.entered(code, reply.state);
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
	async resync(): Promise<void> {
		if (!this.code || this.out) return;
		const reply = await this.transport.send({ kind: 'ResyncRequest' }, { quiet: true });
		if (reply.ok) this.store.applyState(reply.state);
		else if (reply.error === 'not_in_room') this.goOut('removed');
		else if (reply.error === 'room_not_found') this.goOut('room_gone');
	}

	private reset(): void {
		this.close();
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
				this.store.applyServerEvent(event);
				if (event.kind === 'RoomClosed') this.goOut('host_left');
			}),
			this.transport.onPrivateEvent((event) => {
				if (event.kind === 'RemovedFromRoom') this.goOut('left_elsewhere');
				else this.store.applyPrivateEvent(event);
			})
		);
	}

	/** Resync whenever this phone may have missed something. */
	private watch(): void {
		this.listen();
		if (this.watchers.length > 0) return;
		const resync = () => void this.resync();
		this.watchers.push(this.transport.onReconnect(resync), this.transport.onForeground(resync));
	}
}

/** The real transport: the app's one socket.io connection and the page's
 * visibility. */
const socketTransport: RoomTransport = {
	send: sendAction,
	onServerEvent,
	onPrivateEvent,
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
onActionError((refusal) => gameStore.showInfoPopup(formatRefusal(refusal, i18n.lang), 'bad', 4000));
