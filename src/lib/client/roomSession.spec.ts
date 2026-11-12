// The phone-side Room module, through a fake transport: entering, catching
// up after a gap, and finding out this phone is out - no browser, no server.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RoomSession, type RoomTransport } from './roomSession.svelte';
import { GameStore } from './gameStore.svelte';
import type { ClientAction, PrivateInfo, ServerEvent } from '$lib/shared/events';
import type { RoomPublicState } from '$lib/shared/gameTypes';

const state = (phase: RoomPublicState['phase'] = 'SEATING') =>
	({ roomCode: '123456', phase, seats: [], hostSessionId: 'host' }) as unknown as RoomPublicState;

class FakeTransport implements RoomTransport {
	sent: ClientAction[] = [];
	replies: Partial<Record<ClientAction['kind'], unknown>> = {};
	/** What the server sends privately before it answers (a reload's catch-up). */
	beforeReply: Partial<Record<ClientAction['kind'], PrivateInfo[]>> = {};
	private server: ((e: ServerEvent) => void)[] = [];
	private priv: ((e: PrivateInfo) => void)[] = [];
	private reconnect: (() => void)[] = [];
	private foreground: (() => void)[] = [];
	restarts = 0;
	async restart() {
		this.restarts++;
	}

	async send(action: ClientAction) {
		this.sent.push(action);
		for (const e of this.beforeReply[action.kind] ?? []) this.whisper(e);
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

// The diary's home, which a node test run doesn't have.
const saved = new Map<string, string>();
vi.stubGlobal('localStorage', {
	getItem: (k: string) => saved.get(k) ?? null,
	setItem: (k: string, v: string) => saved.set(k, v)
});

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

	it('a reload mid-turn keeps the role and the turn the server replays before answering', async () => {
		transport.replies.RoomJoin = { ok: true, state: state('NIGHT') };
		transport.beforeReply.RoomJoin = [
			{ kind: 'YourRole', role: 'WITCH' },
			{
				kind: 'YourTurnPrompt',
				role: 'WITCH',
				context: { witch: { killedSeat: 3 } } as never,
				replay: true
			}
		];
		await room.open('123456', 's1');
		expect(store.myRole).toBe('WITCH');
		expect(store.myTurnRole).toBe('WITCH');
		expect(store.turnContext).not.toBeNull();
	});
});

describe('catching up after a gap', () => {
	const turn = (role: 'WITCH' | 'SEER', replay = true): PrivateInfo => ({
		kind: 'YourTurnPrompt',
		role,
		context: { seat: 1 } as never,
		replay
	});
	const atNight = (extra: object = {}) => ({
		ok: true,
		state: { ...state('NIGHT'), nightNumber: 1, gameId: 'g1', ...extra }
	});

	beforeEach(async () => {
		saved.clear();
		transport.replies.RoomJoin = atNight();
		transport.replies.ResyncRequest = atNight();
		await room.open('123456', 's1');
	});

	it('an old prompt goes away when the server no longer owes it', async () => {
		transport.whisper(turn('WITCH'));
		expect(store.myTurnRole).toBe('WITCH');
		transport.backInForeground();
		await flush();
		expect(store.myTurnRole).toBe(null);
	});

	it('a prompt still owed stays up, keeping what was picked', async () => {
		transport.whisper(turn('WITCH'));
		transport.beforeReply.ResyncRequest = [turn('WITCH')];
		transport.backInForeground();
		await flush();
		expect(store.myTurnRole).toBe('WITCH');
		expect(store.turnContext).not.toBe(null);
	});

	it('the same role on a new night is a new turn, not the old one kept', async () => {
		transport.whisper(turn('WITCH'));
		store.packKill = { bySeat: 2, target: 3 };
		transport.beforeReply.ResyncRequest = [turn('WITCH')];
		transport.backInForeground();
		await flush();
		expect(store.packKill).not.toBe(null);
		transport.replies.ResyncRequest = atNight({ nightNumber: 2 });
		transport.backInForeground();
		await flush();
		expect(store.packKill).toBe(null);
		expect(store.myTurnRole).toBe('WITCH');
	});

	it('a confirm the server remembers survives; one it does not is dropped', async () => {
		transport.whisper(turn('SEER'));
		transport.whisper({ kind: 'StageConfirmed' });
		transport.beforeReply.ResyncRequest = [turn('SEER')];
		transport.backInForeground();
		await flush();
		expect(store.stageConfirmed).toBe(false);
		transport.beforeReply.ResyncRequest = [turn('SEER'), { kind: 'StageConfirmed' }];
		transport.backInForeground();
		await flush();
		expect(store.stageConfirmed).toBe(true);
	});

	it('a role the server no longer replays (a missed Re-deal) is dropped', async () => {
		transport.whisper({ kind: 'YourRole', role: 'SEER' });
		transport.backInForeground();
		await flush();
		expect(store.myRole).toBe(null);
	});

	it('a missed restart clears the old game, a new diary included', async () => {
		store.logActivity({ key: 'text' } as never);
		transport.replies.ResyncRequest = atNight({ gameId: 'g2' });
		transport.backInForeground();
		await flush();
		expect(store.activityLog).toEqual([]);
	});

	it('a replayed seer result is logged once, and pops up only if it was news', async () => {
		const result: PrivateInfo = {
			kind: 'SeerResult',
			targetSeat: 2,
			isWolf: true,
			replay: true,
			nightNumber: 1
		};
		transport.beforeReply.ResyncRequest = [result];
		transport.backInForeground();
		await flush();
		expect(store.activityLog).toHaveLength(1);
		expect(store.infoPopup).not.toBe(null);
		expect(store.lastSeerResult).toEqual({ targetSeat: 2, isWolf: true });
		store.dismissInfoPopup();
		transport.backInForeground();
		await flush();
		expect(store.activityLog).toHaveLength(1);
		expect(store.infoPopup).toBe(null);
	});

	it('an older night’s result goes in the diary under that night, not on the prompt', async () => {
		transport.replies.ResyncRequest = atNight({ nightNumber: 2 });
		transport.beforeReply.ResyncRequest = [
			{ kind: 'SeerResult', targetSeat: 2, isWolf: false, replay: true, nightNumber: 1 }
		];
		transport.backInForeground();
		await flush();
		expect(store.lastSeerResult).toBe(null);
		expect(store.activityLog[0].round.n).toBe(1);
	});

	it('a Re-deal landing mid catch-up beats the role that catch-up sent', async () => {
		let release = () => {};
		const send = transport.send.bind(transport);
		transport.send = (async (action: ClientAction) => {
			transport.whisper({ kind: 'YourRole', role: 'SEER' });
			await new Promise<void>((r) => (release = r));
			return send(action);
		}) as never;
		transport.backInForeground();
		await flush();
		transport.broadcast({ kind: 'RolesRerolled' });
		release();
		await flush();
		expect(store.myRole).toBe(null);
	});

	it('a stage change landing mid catch-up beats the prompt that catch-up sent', async () => {
		let release = () => {};
		const send = transport.send.bind(transport);
		transport.send = (async (action: ClientAction) => {
			transport.whisper(turn('SEER'));
			await new Promise<void>((r) => (release = r));
			return send(action);
		}) as never;
		transport.backInForeground();
		await flush();
		transport.broadcast({ kind: 'StageChanged', stage: { kind: 'ROLE_TURN' } });
		release();
		await flush();
		expect(store.myTurnRole).toBe(null);
	});

	it('a stopped game leaves nothing of its turn behind', async () => {
		store.stageConfirmed = true;
		store.coupleConfirmed = true;
		store.packKill = { bySeat: 2, target: 3 };
		store.roleDoneByOther = true;
		transport.broadcast({ kind: 'GameReset' });
		expect(store.stageConfirmed).toBe(false);
		expect(store.coupleConfirmed).toBe(false);
		expect(store.packKill).toBe(null);
		expect(store.roleDoneByOther).toBe(false);
	});

	it('a new game’s id reaches the phone, so its diary is saved from the start', async () => {
		transport.broadcast({
			kind: 'PhaseChanged',
			phase: 'FIRST_NIGHT',
			nightNumber: 1,
			gameId: 'g9'
		});
		expect(store.state?.gameId).toBe('g9');
	});

	it('a replayed shot status is logged and pops up once', async () => {
		transport.beforeReply.ResyncRequest = [{ kind: 'ShotStatus', canShoot: true, replay: true }];
		transport.backInForeground();
		await flush();
		expect(store.infoPopup).not.toBe(null);
		store.dismissInfoPopup();
		transport.backInForeground();
		await flush();
		expect(store.activityLog).toHaveLength(1);
		expect(store.infoPopup).toBe(null);
	});

	it('a replayed partner is restored without a second diary line', async () => {
		const couple: PrivateInfo = { kind: 'CoupleRevealed', partnerSeat: 3, replay: true };
		transport.beforeReply.ResyncRequest = [couple];
		transport.backInForeground();
		await flush();
		transport.backInForeground();
		await flush();
		expect(store.myPartnerSeat).toBe(3);
		expect(store.activityLog).toHaveLength(1);
	});

	it('on a reload the replayed lines join the saved diary rather than being wiped', async () => {
		store.logActivity({ key: 'text', args: ['nightPrompt', 'roleDoneByOther'] } as never);
		transport.beforeReply.RoomJoin = [{ kind: 'CoupleRevealed', partnerSeat: 3, replay: true }];
		const fresh = new GameStore();
		await new RoomSession(fresh, transport).open('123456', 's1');
		expect(fresh.activityLog).toHaveLength(2);
	});
});

describe('the game-over screen after a reload', () => {
	it('draws from the snapshot; the voice has nothing new to say', async () => {
		transport.replies.RoomJoin = {
			ok: true,
			state: {
				...state('GAME_OVER'),
				winner: 'wolves',
				identities: { 1: 'SEER' },
				coupleSeats: [1, 2]
			}
		};
		await room.open('123456', 's1');
		expect(store.gameOverView).toEqual({
			winner: 'wolves',
			identities: { 1: 'SEER' },
			coupleSeats: [1, 2]
		});
		expect(store.gameOverResult).toBe(null);
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

	it('ignores another room’s news (a room this phone walked away from)', async () => {
		await room.open('123456', 's1');
		transport.broadcast({
			kind: 'StateSnapshot',
			state: { ...state('GAME_OVER'), roomCode: '999999' }
		});
		expect(store.state?.roomCode).toBe('123456');
		expect(store.state?.phase).toBe('SEATING');
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

describe('a dead connection after the screen was locked', () => {
	it('starts a fresh connection and catches up when the catch-up gets no answer', async () => {
		await room.open('123456', 's1');
		let calls = 0;
		const send = transport.send.bind(transport);
		transport.send = (async (action: ClientAction) => {
			if (action.kind === 'ResyncRequest' && calls++ === 0) {
				transport.sent.push(action);
				return { ok: false, error: 'timeout' };
			}
			return send(action);
		}) as typeof transport.send;
		transport.backInForeground();
		await flush();
		expect(transport.restarts).toBe(1);
		expect(kinds(transport)).toEqual(['RoomJoin', 'ResyncRequest', 'ResyncRequest']);
		expect(store.state?.phase).toBe('NIGHT');
	});

	it('does not restart for a refusal', async () => {
		await room.open('123456', 's1');
		transport.replies.ResyncRequest = { ok: false, error: 'not_in_room' };
		transport.backInForeground();
		await flush();
		expect(transport.restarts).toBe(0);
		expect(room.out).toBe('removed');
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
