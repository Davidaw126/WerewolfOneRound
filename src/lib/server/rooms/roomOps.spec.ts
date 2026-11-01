// Room operations, tested for what they change AND who is told what -
// against a real Redis (database 12; the other server specs have 13-15 and
// test files run in parallel) and a fake Socket.IO server that records every
// message and every channel a session is taken out of.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';

import type { GameState } from '../../game/types';

process.env.REDIS_URL = 'redis://127.0.0.1:6379/12';

const { redis, closeRedisConnections } = await import('../redis');
const room = await import('./roomRepo');
const ops = await import('./roomOps');
const { getSession, setSessionRoom } = await import('../session');
const { loadGameState } = await import('../game/gameStateRepo');
const { gameStateKey } = await import('./keys');
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

describe('catching up in a game: everything private the phone is owed comes back', () => {
	/** A started game with `change` applied to its saved state. */
	async function gameWith(change: (s: GameState) => void): Promise<string> {
		const code = await startedRoom();
		const game = (await loadGameState(code))!;
		change(game);
		await redis.set(gameStateKey(code), JSON.stringify(game));
		sent = [];
		return code;
	}
	const seatOfRole = (s: GameState, role: string) =>
		Object.values(s.players).find((p) => p.role === role)!;
	const owed = async (code: string, session: string) => {
		const reply = await ops.catchUp(code, session);
		expect(reply.ok).toBe(true);
		return toSession(session).map((s) => s.event);
	};

	it('its role, even if it never tapped to view it during seating', async () => {
		const code = await gameWith(() => {});
		const game = (await loadGameState(code))!;
		expect(await owed(code, 's1')).toContainEqual({ kind: 'YourRole', role: game.players[1].role });
	});

	it("a lover's partner, for the rest of the game", async () => {
		const code = await gameWith((s) => {
			s.lovers = [1, 3];
		});
		expect(await owed(code, 's3')).toContainEqual({
			kind: 'CoupleRevealed',
			partnerSeat: 1,
			replay: true
		});
		sent = [];
		expect((await owed(code, 's2')).map((e) => e.kind)).not.toContain('CoupleRevealed');
	});

	it('its own seer checks, and nobody else’s', async () => {
		let seer = 0;
		const code = await gameWith((s) => {
			seer = seatOfRole(s, 'SEER').seat;
			s.seerChecks = [{ round: 1, seat: seer, targetSeat: 2, isBad: true }];
		});
		expect(await owed(code, `s${seer}`)).toContainEqual({
			kind: 'SeerResult',
			targetSeat: 2,
			isWolf: true,
			replay: true,
			nightNumber: 1
		});
		const other = seer === 1 ? 's2' : 's1';
		sent = [];
		expect((await owed(code, other)).map((e) => e.kind)).not.toContain('SeerResult');
	});

	it('whether its fallen 猎人 may shoot', async () => {
		const code = await gameWith((s) => {
			s.shotStatuses = { 2: false };
		});
		expect(await owed(code, 's2')).toContainEqual({
			kind: 'ShotStatus',
			canShoot: false,
			replay: true
		});
		sent = [];
		expect((await owed(code, 's1')).map((e) => e.kind)).not.toContain('ShotStatus');
	});

	it('a status stage this seat already confirmed stays confirmed', async () => {
		let seat = 0;
		const code = await gameWith((s) => {
			seat = seatOfRole(s, 'SEER').seat;
			s.players[seat].role = 'HUNTER';
			s.phase = 'NIGHT';
			s.currentStepKey = 'role:HUNTER';
			s.stageConfirms = [seat];
		});
		const events = (await owed(code, `s${seat}`)).map((e) => e.kind);
		expect(events).toContain('YourTurnPrompt');
		expect(events.indexOf('StageConfirmed')).toBeGreaterThan(events.indexOf('YourTurnPrompt'));
	});

	it('the snapshot brings back the announced results and the couple at game over', async () => {
		const code = await gameWith((s) => {
			s.phase = 'GAME_OVER';
			s.winner = 'GOOD';
			s.lovers = [1, 2];
			s.announcedNightDeaths = [3];
			s.announcedDayResult = {
				eliminatedSeat: 1,
				identity: null,
				tie: false,
				followDeathSeat: null,
				followDeathIdentity: null,
				idiotRevealed: false
			};
		});
		const reply = await ops.catchUp(code, 's1');
		if (!reply.ok) throw new Error(reply.error);
		expect(reply.state.lastNightDeaths).toEqual([3]);
		expect(reply.state.lastDayResult?.eliminatedSeat).toBe(1);
		expect(reply.state.coupleSeats).toEqual([1, 2]);
		expect(reply.state.identities).toBeDefined();
	});
});

describe('the Host moving the table on while phones are busy', () => {
	// These race for the room lock, whose retry wait must really pass.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
	});

	const roleOf = async (code: string, seat: number) => room.currentRoleOfSeat(code, seat);
	const lastRoleTold = (session: string) =>
		toSession(session)
			.filter((s) => s.event.kind === 'YourRole')
			.at(-1)?.event.role;

	it('a look at the role racing a Re-deal never leaves the phone with the old card', async () => {
		for (let i = 0; i < 25; i++) {
			const code = await seatingRoom(3);
			await Promise.all([ops.revealRole(code, 's1'), ops.rerollRoles(code, HOST)]);
			const events = sent.filter(
				(s) =>
					(s.channel === sessionChannel('s1') && s.event.kind === 'YourRole') ||
					s.event.kind === 'RolesRerolled'
			);
			const last = events.at(-1)!.event;
			if (last.kind === 'YourRole') expect(last.role).toBe(await roleOf(code, 1));
		}
	});

	it('a catch-up racing a Re-deal never ends on the old card either', async () => {
		for (let i = 0; i < 25; i++) {
			const code = await seatingRoom(3);
			await ops.revealRole(code, 's1');
			sent = [];
			await Promise.all([ops.catchUp(code, 's1'), ops.rerollRoles(code, HOST)]);
			const events = sent.filter(
				(s) =>
					(s.channel === sessionChannel('s1') && s.event.kind === 'YourRole') ||
					s.event.kind === 'RolesRerolled'
			);
			const last = events.at(-1)!.event;
			if (last.kind === 'YourRole') expect(last.role).toBe(await roleOf(code, 1));
		}
	});

	it('a double tap on Start starts one game', async () => {
		const code = await seatingRoom(3);
		const replies = await Promise.all([ops.startGame(code, HOST), ops.startGame(code, HOST)]);
		expect(replies.filter((r) => r.ok)).toHaveLength(1);
		expect(kinds(toSession('s1')).filter((k) => k === 'YourRole')).toHaveLength(1);
	});

	it('a Re-deal tapped as the game starts is refused, not applied to a running game', async () => {
		const code = await seatingRoom(3);
		const [started, rerolled] = await Promise.all([
			ops.startGame(code, HOST),
			new Promise<Awaited<ReturnType<typeof ops.rerollRoles>>>((r) =>
				setImmediate(() => r(ops.rerollRoles(code, HOST)))
			)
		]);
		expect(started.ok).toBe(true);
		expect(rerolled).toEqual({ ok: false, error: 'invalid_phase' });
		const game = (await loadGameState(code))!;
		expect(lastRoleTold('s1')).toBe(game.players[1].role);
		expect(kinds(toRoom(code))).not.toContain('RolesRerolled');
	});

	it('phones are told the new game’s id the moment it starts', async () => {
		const code = await seatingRoom(3);
		await ops.startGame(code, HOST);
		const game = (await loadGameState(code))!;
		expect(toRoom(code).some((s) => s.event.gameId === String(game.startedAt))).toBe(true);
	});
});
