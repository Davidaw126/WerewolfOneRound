// Room operations, tested for what they change AND who is told what -
// against a real Redis (database 12; the other server specs have 13-15 and
// test files run in parallel) and a fake Socket.IO server that records every
// message and every channel a session is taken out of.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';

process.env.REDIS_URL = 'redis://127.0.0.1:6379/12';

const { redis, closeRedisConnections } = await import('../redis');
const room = await import('./roomRepo');
const ops = await import('./roomOps');
const { getSession, setSessionRoom } = await import('../session');
const { setIoInstance, roomChannel, sessionChannel } = await import('../socket/emit');

type Event = { kind: string } & Record<string, unknown>;
let sent: { channel: string; event: Event }[] = [];
let left: { channel: string; room: string }[] = [];
setIoInstance({
	to: (channel: string) => ({
		emit: (_name: string, event: Event) => sent.push({ channel, event })
	}),
	in: (channel: string) => ({
		socketsLeave: (room: string) => left.push({ channel, room })
	})
} as never);

const HOST = 'host-session';
const SETUP = { WEREWOLF: 1, SEER: 1, VILLAGER: 1 } as const;

const toRoom = (code: string) => sent.filter((s) => s.channel === roomChannel(code));
const toSession = (id: string) => sent.filter((s) => s.channel === sessionChannel(id));
const kinds = (list: { event: Event }[]) => list.map((s) => s.event.kind);

/** A room in SEATING with SETUP dealt and `seated` seats taken by s1, s2, ... */
async function seatingRoom(seated: number): Promise<string> {
	const opened = await ops.openRoom(HOST);
	if (!opened.ok) throw new Error(opened.error);
	const code = opened.roomCode;
	await ops.submitConfig(code, HOST, SETUP);
	for (let seat = 1; seat <= seated; seat++) {
		await setSessionRoom(`s${seat}`, code);
		await ops.takeSeat(code, `s${seat}`, seat, `P${seat}`);
	}
	sent = [];
	return code;
}

async function startedRoom(): Promise<string> {
	const code = await seatingRoom(3);
	expect((await ops.startGame(code, HOST)).ok).toBe(true);
	sent = [];
	return code;
}

beforeAll(async () => {
	await redis.ping();
});

beforeEach(async () => {
	expect(redis.options.db).toBe(12);
	await redis.flushdb();
	sent = [];
	left = [];
	// The game's night timers must not outlive a test.
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
	vi.useRealTimers();
});

afterAll(async () => {
	await closeRedisConnections();
});

describe('setting up', () => {
	it('only the Host submits the setup, and the room gets the whole new state', async () => {
		const code = (await ops.openRoom(HOST)) as { roomCode: string };
		expect(await ops.submitConfig(code.roomCode, 's1', SETUP)).toEqual({
			ok: false,
			error: 'not_host'
		});
		expect(sent).toEqual([]);
		expect((await ops.submitConfig(code.roomCode, HOST, SETUP)).ok).toBe(true);
		expect(kinds(toRoom(code.roomCode))).toEqual(['StateSnapshot']);
	});

	it('refuses an empty setup without touching the room', async () => {
		const opened = (await ops.openRoom(HOST)) as { roomCode: string };
		expect(await ops.submitConfig(opened.roomCode, HOST, { SEER: 0 })).toEqual({
			ok: false,
			error: 'empty_config'
		});
		expect((await room.readRoomHash(opened.roomCode))?.phase).toBe('LOBBY');
	});

	it('a taken seat goes to the room; a looked-at role only to that player', async () => {
		const code = await seatingRoom(1);
		await setSessionRoom('s2', code);
		await ops.takeSeat(code, 's2', 2, 'P2');
		expect(kinds(toRoom(code))).toEqual(['SeatUpdated']);
		sent = [];
		expect((await ops.revealRole(code, 's2')).ok).toBe(true);
		expect(toRoom(code)).toEqual([]);
		expect(kinds(toSession('s2'))).toEqual(['YourRole']);
		expect(await ops.revealRole(code, 's9')).toEqual({ ok: false, error: 'not_seated' });
	});
});

describe('Start game', () => {
	it('starts in one step: seats locked, game dealt, the room told', async () => {
		const code = await seatingRoom(3);
		expect(await ops.startGame(code, HOST)).toEqual({ ok: true });
		const hash = await room.readRoomHash(code);
		expect(hash?.lockStatus).toBe(true);
		expect(hash?.phase).toBe('FIRST_NIGHT');
		expect(kinds(toRoom(code))).toContain('PhaseChanged');
		expect(kinds(toRoom(code))).toContain('LockUpdated');
	});

	it('a refused start (an empty seat) says why and leaves the seats open', async () => {
		const code = await seatingRoom(2);
		const reply = await ops.startGame(code, HOST);
		expect(reply).toMatchObject({ ok: false, error: 'E01' });
		expect(!reply.ok && reply.issues?.[0].params).toEqual({ numberOfSeats: 3, playerCount: 2 });
		expect((await room.readRoomHash(code))?.lockStatus).toBe(false);
		expect(sent).toEqual([]);
		// Nobody is stuck: the last player can still sit down.
		await setSessionRoom('s3', code);
		expect((await ops.takeSeat(code, 's3', 3, 'P3')).ok).toBe(true);
	});

	it('only the Host starts, and only once', async () => {
		const code = await seatingRoom(3);
		expect(await ops.startGame(code, 's1')).toEqual({ ok: false, error: 'not_host' });
		expect((await room.readRoomHash(code))?.lockStatus).toBe(false);
		expect((await ops.startGame(code, HOST)).ok).toBe(true);
		expect(await ops.startGame(code, HOST)).toEqual({ ok: false, error: 'invalid_phase' });
	});
});

describe('Re-deal and stopping', () => {
	it('a Re-deal is the Host’s, during seating, and tells the room', async () => {
		const code = await seatingRoom(1);
		expect(await ops.rerollRoles(code, 's1')).toEqual({ ok: false, error: 'not_host' });
		expect((await ops.rerollRoles(code, HOST)).ok).toBe(true);
		expect(kinds(toRoom(code))).toEqual(['RolesRerolled']);
	});

	it('stopping a game takes the room back to seating', async () => {
		const code = await startedRoom();
		expect((await ops.stopGame(code, HOST)).ok).toBe(true);
		expect(kinds(toRoom(code))).toEqual(['StateSnapshot', 'GameReset']);
		expect((await room.readRoomHash(code))?.phase).toBe('SEATING');
	});
});

describe('Leave', () => {
	it('every phone of the leaving player is told and taken out of the room', async () => {
		const code = await seatingRoom(2);
		expect((await ops.leave(code, 's2')).ok).toBe(true);
		expect(kinds(toRoom(code))).toEqual(['SeatUpdated']);
		expect(toSession('s2').map((s) => s.event)).toEqual([
			{ kind: 'RemovedFromRoom', reason: 'left' }
		]);
		expect(left).toEqual([{ channel: sessionChannel('s2'), room: roomChannel(code) }]);
		expect((await getSession('s2'))?.roomCode ?? null).toBe(null);
	});

	it('a player who had looked at their role leaving re-deals, and says why', async () => {
		const code = await seatingRoom(2);
		await ops.revealRole(code, 's2');
		sent = [];
		await ops.leave(code, 's2');
		expect(toRoom(code).map((s) => s.event)).toContainEqual({
			kind: 'RolesRerolled',
			reason: 'seen_role_left'
		});
	});

	it('a player leaving mid-game ends the round for everyone', async () => {
		const code = await startedRoom();
		await ops.leave(code, 's2');
		expect(kinds(toRoom(code))).toEqual(['StateSnapshot', 'GameReset', 'ErrorToast']);
		expect(toRoom(code)[2].event).toMatchObject({ reason: 'player_left_mid_game', seat: 2 });
	});

	it('the Host leaving closes the room', async () => {
		const code = await seatingRoom(1);
		await ops.leave(code, HOST);
		expect(toRoom(code).map((s) => s.event)).toEqual([{ kind: 'RoomClosed', reason: 'host_left' }]);
		expect(await room.readRoomHash(code)).toBe(null);
	});
});

describe('entering', () => {
	it('a stranger can’t enter once a game is on; a seated player always can, and is caught up', async () => {
		const code = await seatingRoom(3);
		await ops.revealRole(code, 's2');
		await ops.startGame(code, HOST);
		sent = [];
		expect(await ops.enterRoom(code, 'stranger')).toEqual({ ok: false, error: 'room_locked' });
		const back = await ops.enterRoom(code, 's2');
		expect(back.ok && back.state.phase).toBe('FIRST_NIGHT');
		expect(kinds(toSession('s2'))).toContain('YourRole');
	});

	it('an unknown room is not found', async () => {
		expect(await ops.enterRoom('000000', 's1')).toEqual({ ok: false, error: 'room_not_found' });
	});
});
