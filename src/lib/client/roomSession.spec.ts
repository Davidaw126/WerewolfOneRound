// The phone-side Room module, through a fake transport: entering, catching
// up after a gap, and finding out this phone is out - no browser, no server.
import { describe, it, expect, beforeEach } from 'vitest';
import { RoomSession, type RoomTransport } from './roomSession.svelte';
import { GameStore } from './gameStore.svelte';
import type { ClientAction, PrivateInfo, ServerEvent } from '$lib/shared/events';
import type { RoomPublicState } from '$lib/shared/gameTypes';

const state = (phase: RoomPublicState['phase'] = 'SEATING') =>
	({ roomCode: '123456', phase, seats: [], hostSessionId: 'host' }) as unknown as RoomPublicState;

class FakeTransport implements RoomTransport {
	sent: ClientAction[] = [];
	replies: Partial<Record<ClientAction['kind'], unknown>> = {};
	private server: ((e: ServerEvent) => void)[] = [];
	private priv: ((e: PrivateInfo) => void)[] = [];
	private reconnect: (() => void)[] = [];
	private foreground: (() => void)[] = [];

	async send(action: ClientAction) {
		this.sent.push(action);
		return (this.replies[action.kind] ?? { ok: true }) as never;
	}
	onServerEvent(h: (e: ServerEvent) => void) {
		this.server.push(h);
		return () => (this.server = this.server.filter((x) => x !== h));
	}
	onPrivateEvent(h: (e: PrivateInfo) => void) {
		this.priv.push(h);
		return () => (this.priv = this.priv.filter((x) => x !== h));
	}
	onReconnect(h: () => void) {
		this.reconnect.push(h);
		return () => (this.reconnect = this.reconnect.filter((x) => x !== h));
	}
	onForeground(h: () => void) {
		this.foreground.push(h);
		return () => (this.foreground = this.foreground.filter((x) => x !== h));
	}
	broadcast(e: ServerEvent) {
		for (const h of this.server) h(e);
	}
	whisper(e: PrivateInfo) {
		for (const h of this.priv) h(e);
	}
	reconnected() {
		for (const h of this.reconnect) h();
	}
	backInForeground() {
		for (const h of this.foreground) h();
	}
	get listening() {
		return this.server.length + this.priv.length + this.reconnect.length + this.foreground.length;
	}
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const kinds = (t: FakeTransport) => t.sent.map((a) => a.kind);

let transport: FakeTransport;
let store: GameStore;
let room: RoomSession;

beforeEach(() => {
	transport = new FakeTransport();
	transport.replies.RoomJoin = { ok: true, state: state() };
	transport.replies.ResyncRequest = { ok: true, state: state('NIGHT') };
	store = new GameStore();
	room = new RoomSession(store, transport);
});

describe('entering a room', () => {
	it('from the lobby takes one round trip; the room page then sends nothing more', async () => {
		expect((await room.enter('123456')).ok).toBe(true);
		expect(await room.open('123456', 's1')).toBe(true);
		expect(kinds(transport)).toEqual(['RoomJoin']);
		expect(store.state?.phase).toBe('SEATING');
		expect(store.viewerSessionId).toBe('s1');
	});

	it('on a reload (no lobby first), the room page enters itself', async () => {
		expect(await room.open('123456', 's1')).toBe(true);
		expect(kinds(transport)).toEqual(['RoomJoin']);
	});

	it('a room that can’t be entered says so, and nothing is left showing', async () => {
		transport.replies.RoomJoin = { ok: false, error: 'room_locked' };
		store.applyState(state('NIGHT'));
		expect(await room.open('654321', 's1')).toBe(false);
		expect(store.state).toBe(null);
	});

	it('room events reach the store from the moment of entering', async () => {
		await room.enter('123456');
		transport.broadcast({ kind: 'LockUpdated', locked: true });
		expect(store.state?.lockStatus).toBe(true);
	});
});

describe('staying in step', () => {
	it('catches up after a reconnect or coming back to the foreground', async () => {
		await room.open('123456', 's1');
		transport.reconnected();
		await flush();
		expect(store.state?.phase).toBe('NIGHT');
		transport.backInForeground();
		await flush();
		expect(kinds(transport)).toEqual(['RoomJoin', 'ResyncRequest', 'ResyncRequest']);
	});

	it('stops listening when the room page goes away', async () => {
		await room.open('123456', 's1');
		room.close();
		expect(transport.listening).toBe(0);
		transport.reconnected();
		await flush();
		expect(kinds(transport)).toEqual(['RoomJoin']);
	});
});

describe('finding out this phone is out', () => {
	it('the Host leaving closes the room', async () => {
		await room.open('123456', 's1');
		transport.broadcast({ kind: 'RoomClosed', reason: 'host_left' });
		expect(room.out).toBe('host_left');
	});

	it('leaving on another phone reaches this one', async () => {
		await room.open('123456', 's1');
		transport.whisper({ kind: 'RemovedFromRoom', reason: 'left' });
		expect(room.out).toBe('left_elsewhere');
	});

	it('this phone’s own Leave is not news to it', async () => {
		await room.open('123456', 's1');
		await room.leave();
		transport.whisper({ kind: 'RemovedFromRoom', reason: 'left' });
		expect(room.out).toBe(null);
	});

	it('a phone that missed the news learns it on its next catch-up', async () => {
		await room.open('123456', 's1');
		transport.replies.ResyncRequest = { ok: false, error: 'not_in_room' };
		transport.backInForeground();
		await flush();
		expect(room.out).toBe('removed');
	});

	it('a room that expired meanwhile is gone', async () => {
		await room.open('123456', 's1');
		transport.replies.ResyncRequest = { ok: false, error: 'room_not_found' };
		transport.reconnected();
		await flush();
		expect(room.out).toBe('room_gone');
	});

	it('entering another room starts clean', async () => {
		await room.open('123456', 's1');
		transport.broadcast({ kind: 'RoomClosed', reason: 'host_left' });
		await room.enter('654321');
		expect(room.out).toBe(null);
	});
});
