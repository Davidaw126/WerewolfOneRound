// The Room module, tested through its interface against a real Redis (the
// Lua scripts are part of what's under test). Uses database 15 so it never
// touches a dev server's rooms in database 0; needs a local Redis running,
// same as `npm run dev` does.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';

const TEST_REDIS_URL = 'redis://127.0.0.1:6379/15';
process.env.REDIS_URL = TEST_REDIS_URL;

const { redis, closeRedisConnections } = await import('../redis');
const room = await import('./roomRepo');
const { startAndSaveGame, loadGameState } = await import('../game/gameStateRepo');
const { recordGamePhase } = room;
const { buildSetup } = await import('../../game/rules/setup');
const { defaultRuleConfig } = await import('../../game/defaultRuleConfig');

const HOST = 'host-session';
const config = {
	roleConfig: { WEREWOLF: 1, SEER: 1, VILLAGER: 1 },
	numberOfSeats: 3,
	ruleOverrides: {}
};

beforeAll(async () => {
	try {
		await redis.ping();
	} catch {
		throw new Error(
			`These tests need a local Redis at ${TEST_REDIS_URL} (brew services start redis)`
		);
	}
});

beforeEach(async () => {
	// Never flush anything but the dedicated test database.
	expect(redis.options.db).toBe(15);
	await redis.flushdb();
});

afterAll(async () => {
	await closeRedisConnections();
});

async function seatedRoom(): Promise<string> {
	const code = await room.createRoom(HOST);
	expect(await room.submitRoomConfigAtomic(code, HOST, config)).toEqual({ ok: true });
	for (const seat of [1, 2, 3]) {
		expect(await room.takeSeatAtomic(code, `s${seat}`, seat, `P${seat}`)).toEqual({ ok: true });
	}
	return code;
}

/** Starts a game whose deal differs from the seating deal, so a test can
 * tell which store answered. */
async function startGameWithRoles(code: string) {
	await room.setSeatsLocked(code, true);
	const result = await startAndSaveGame(code, async () => ({
		roomCode: code,
		ruleConfig: defaultRuleConfig(),
		setup: buildSetup({ WEREWOLF: 1, SEER: 1, VILLAGER: 1 }),
		deal: { identities: { '1': 'SEER', '2': 'VILLAGER', '3': 'WEREWOLF' }, buried: null },
		players: [1, 2, 3].map((seat) => ({ seat, sessionId: `s${seat}`, nickname: `P${seat}` })),
		now: 1000
	}));
	if ('ok' in result) throw new Error(result.error);
	await recordGamePhase(code, result.state.phase, result.state.round);
}

describe('creating and setting up a room', () => {
	it('makes the creator the Host and nobody else', async () => {
		const code = await room.createRoom(HOST);
		expect(code).toMatch(/^\d{6}$/);
		expect(await room.hostSessionOf(code)).toBe(HOST);
		expect(await room.isHost(code, HOST)).toBe(true);
		expect(await room.isHost(code, 's1')).toBe(false);
		expect((await room.readRoomHash(code))?.phase).toBe('LOBBY');
	});

	it('deals the setup and moves to SEATING in one step, keeping the rule switches', async () => {
		const code = await room.createRoom(HOST);
		await room.submitRoomConfigAtomic(code, HOST, {
			...config,
			ruleOverrides: { cupidPoisonBlocksHunter: true, witch: { canPoisonSelf: true } }
		});
		const hash = await room.readRoomHash(code);
		expect(hash?.phase).toBe('SEATING');
		expect(hash?.numberOfSeats).toBe(3);
		expect(hash?.ruleOverrides).toEqual({
			cupidPoisonBlocksHunter: true,
			witch: { canPoisonSelf: true }
		});
		const roles = await Promise.all([1, 2, 3].map((s) => room.currentRoleOfSeat(code, s)));
		expect(roles.sort()).toEqual(['SEER', 'VILLAGER', 'WEREWOLF']);
	});

	it('reads the 丘比特 poison rule a room stored as its own field before', async () => {
		const code = await room.createRoom(HOST);
		await room.submitRoomConfigAtomic(code, HOST, config);
		await redis.hset(`wolf:room:${code}`, { cupidPoisonBlocksHunter: '1' });
		expect((await room.readRoomHash(code))?.ruleOverrides).toEqual({
			cupidPoisonBlocksHunter: true
		});
	});

	it('still reads a room saved with Chinese role names before roles were stored as ids', async () => {
		const code = await room.createRoom(HOST);
		await redis.hset(`wolf:room:${code}`, {
			phase: 'SEATING',
			numberOfSeats: '2',
			roleConfig: JSON.stringify({ 普通狼人: 1, 预言家: 1 })
		});
		await redis.hset(`wolf:room:${code}:identities`, { '1': '预言家', '2': '普通狼人' });
		expect((await room.readRoomHash(code))?.roleConfig).toEqual({ WEREWOLF: 1, SEER: 1 });
		expect(await room.currentRoleOfSeat(code, 1)).toBe('SEER');
		await room.redeal(code);
		const roles = await Promise.all([1, 2].map((s) => room.currentRoleOfSeat(code, s)));
		expect(roles.sort()).toEqual(['SEER', 'WEREWOLF']);
	});

	it('reads a game phase stored under its pre-engine name as in progress', async () => {
		const code = await room.createRoom(HOST);
		await redis.hset(`wolf:room:${code}`, { phase: 'DAY_VOTE' });
		expect((await room.readRoomHash(code))?.phase).toBe('VOTE');
	});

	it('lets only the Host submit the setup, and never changes who the Host is', async () => {
		const code = await room.createRoom(HOST);
		expect(await room.submitRoomConfigAtomic(code, 's1', config)).toEqual({
			ok: false,
			error: 'not_host'
		});
		expect((await room.readRoomHash(code))?.phase).toBe('LOBBY');
		await room.submitRoomConfigAtomic(code, HOST, config);
		expect(await room.hostSessionOf(code)).toBe(HOST);
	});

	it('refuses a second setup once seating has started', async () => {
		const code = await seatedRoom();
		expect(await room.submitRoomConfigAtomic(code, HOST, config)).toEqual({
			ok: false,
			error: 'game_already_started'
		});
	});
});

describe('seats', () => {
	it('knows who sits where, both ways', async () => {
		const code = await seatedRoom();
		expect(await room.seatOf(code, 's2')).toBe(2);
		expect(await room.sessionInSeat(code, 2)).toBe('s2');
		expect(await room.seatOf(code, 'stranger')).toBeNull();
		expect(await room.belongsToRoom(code, 's2')).toBe(true);
		expect(await room.belongsToRoom(code, HOST)).toBe(true);
		expect(await room.belongsToRoom(code, 'stranger')).toBe(false);
	});

	it('carries a dealt role along when a player switches seats', async () => {
		const code = await room.createRoom(HOST);
		await room.submitRoomConfigAtomic(code, HOST, config);
		await room.takeSeatAtomic(code, 's1', 1, 'P1');
		const before = await room.currentRoleOfSeat(code, 1);
		await room.takeSeatAtomic(code, 's1', 3, 'P1');
		expect(await room.currentRoleOfSeat(code, 3)).toBe(before);
		expect(await room.seatOf(code, 's1')).toBe(3);
	});

	it('rejects a taken seat, a taken name, and any seat change once locked', async () => {
		const code = await seatedRoom();
		expect(await room.takeSeatAtomic(code, 'new', 1, 'New')).toMatchObject({ error: 'seat_taken' });
		await room.freeSeat(code, 's3');
		expect(await room.takeSeatAtomic(code, 'new', 3, 'P1')).toMatchObject({ error: 'name_taken' });
		await room.setSeatsLocked(code, true);
		expect(await room.takeSeatAtomic(code, 'new', 3, 'New')).toMatchObject({
			error: 'seating_closed'
		});
	});

	it('frees a seat when its player leaves', async () => {
		const code = await seatedRoom();
		expect(await room.freeSeat(code, 's2')).toEqual({ vacated: true, redealt: false });
		expect(await room.sessionInSeat(code, 2)).toBeNull();
		expect(await room.freeSeat(code, 's2')).toEqual({ vacated: false, redealt: false });
	});
});

describe('seen roles and Re-deal', () => {
	it('replays a role only to a player who has already looked at it', async () => {
		const code = await seatedRoom();
		expect(await room.getRevealedRoleIfAny(code, 's1')).toBeNull();
		await room.markRevealed(code, 's1');
		expect(await room.getRevealedRoleIfAny(code, 's1')).toBe(await room.currentRoleOfSeat(code, 1));
	});

	it('Re-deal makes every earlier look stale', async () => {
		const code = await seatedRoom();
		await room.markRevealed(code, 's1');
		await room.redeal(code);
		expect(await room.getRevealedRoleIfAny(code, 's1')).toBeNull();
		const roles = await Promise.all([1, 2, 3].map((s) => room.currentRoleOfSeat(code, s)));
		expect(roles.sort()).toEqual(['SEER', 'VILLAGER', 'WEREWOLF']);
	});
});

describe('a seat freed after its role was seen', () => {
	it('re-deals when the leaving player had looked at their role', async () => {
		const code = await seatedRoom();
		await room.markRevealed(code, 's1');
		await room.markRevealed(code, 's2');
		expect(await room.freeSeat(code, 's1')).toEqual({ vacated: true, redealt: true });
		// The whole table was re-dealt, so the other player must look again.
		expect(await room.getRevealedRoleIfAny(code, 's2')).toBeNull();
	});

	it('keeps the deal when the leaving player never looked', async () => {
		const code = await seatedRoom();
		await room.markRevealed(code, 's2');
		const before = await room.currentRoleOfSeat(code, 2);
		expect(await room.freeSeat(code, 's1')).toEqual({ vacated: true, redealt: false });
		expect(await room.getRevealedRoleIfAny(code, 's2')).toBe(before);
	});
});

describe('once a game has started', () => {
	it("answers a seat's role from the game, not the seating deal", async () => {
		const code = await seatedRoom();
		await startGameWithRoles(code);
		expect(await room.currentRoleOfSeat(code, 1)).toBe('SEER');
		expect(await room.currentRoleOfSeat(code, 3)).toBe('WEREWOLF');
	});

	it('answers who sits where from the game, even if the seating data drifts', async () => {
		const code = await seatedRoom();
		await startGameWithRoles(code);
		await redis.del(`wolf:room:${code}:seats`, `wolf:room:${code}:players`);
		expect(await room.sessionInSeat(code, 2)).toBe('s2');
		expect(await room.seatOf(code, 's3')).toBe(3);
		const state = await room.getPublicState(code);
		expect(state?.seats.map((s) => s.username)).toEqual(['P1', 'P2', 'P3']);
	});

	it('shows the real stage to the Host only', async () => {
		const code = await seatedRoom();
		await startGameWithRoles(code);
		expect((await room.getPublicState(code, HOST))?.hostStage).toBeTruthy();
		expect((await room.getPublicState(code, 's1'))?.hostStage).toBeUndefined();
	});

	it('going back to seating keeps the seats, drops the game and re-deals', async () => {
		const code = await seatedRoom();
		await room.markRevealed(code, 's1');
		await startGameWithRoles(code);
		await room.resetToSeating(code);

		const hash = await room.readRoomHash(code);
		expect(hash?.phase).toBe('SEATING');
		expect(hash?.lockStatus).toBe(false);
		expect(await loadGameState(code)).toBeNull();
		expect(await room.sessionInSeat(code, 2)).toBe('s2');
		expect(await room.getRevealedRoleIfAny(code, 's1')).toBeNull();
	});
});

describe('closing a room', () => {
	it('leaves nothing behind', async () => {
		const code = await seatedRoom();
		await startGameWithRoles(code);
		await room.destroyRoom(code);
		expect(await room.roomExists(code)).toBe(false);
		expect(await redis.keys(`wolf:room:${code}*`)).toEqual([]);
	});
});

describe('Host-only operations', () => {
	it('run only for the Host', async () => {
		const code = await seatedRoom();
		expect(await room.asHost(code, 's1', () => room.setSeatsLocked(code, true))).toEqual({
			ok: false,
			error: 'not_host'
		});
		expect((await room.readRoomHash(code))?.lockStatus).toBe(false);
		await room.asHost(code, HOST, () => room.setSeatsLocked(code, true));
		expect((await room.readRoomHash(code))?.lockStatus).toBe(true);
	});
});

describe('Leave', () => {
	it('by the Host closes the room', async () => {
		const code = await seatedRoom();
		expect(await room.leaveRoom(code, HOST)).toEqual({ kind: 'closed' });
		expect(await room.roomExists(code)).toBe(false);
	});

	it('by a player mid-round ends the round for everyone', async () => {
		const code = await seatedRoom();
		await startGameWithRoles(code);
		expect(await room.leaveRoom(code, 's2')).toEqual({ kind: 'round_ended', seat: 2 });
		expect((await room.readRoomHash(code))?.phase).toBe('SEATING');
		expect(await loadGameState(code)).toBeNull();
		expect(await room.seatOf(code, 's2')).toBeNull();
	});

	it('by a player during seating frees their seat', async () => {
		const code = await seatedRoom();
		expect(await room.leaveRoom(code, 's3')).toEqual({
			kind: 'left',
			vacated: true,
			redealt: false
		});
		expect(await room.sessionInSeat(code, 3)).toBeNull();
	});
});
