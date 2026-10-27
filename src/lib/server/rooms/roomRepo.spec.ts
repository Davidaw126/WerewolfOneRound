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
	roleConfig: { 普通狼人: 1, 预言家: 1, 平民: 1 },
	numberOfSeats: 3,
	cupidPoisonBlocksHunter: false,
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
	const result = await startAndSaveGame(code, {
		roomCode: code,
		ruleConfig: defaultRuleConfig(),
		setup: buildSetup({ WEREWOLF: 1, SEER: 1, VILLAGER: 1 }),
		deal: { identities: { '1': 'SEER', '2': 'VILLAGER', '3': 'WEREWOLF' }, buried: null },
		players: [1, 2, 3].map((seat) => ({ seat, sessionId: `s${seat}`, nickname: `P${seat}` })),
		now: 1000
	});
	await recordGamePhase(code, 'NIGHT_ACTIONS', result.state.round);
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
			cupidPoisonBlocksHunter: true,
			ruleOverrides: { witch: { canPoisonSelf: true } }
		});
		const hash = await room.readRoomHash(code);
		expect(hash?.phase).toBe('SEATING');
		expect(hash?.numberOfSeats).toBe(3);
		expect(hash?.cupidPoisonBlocksHunter).toBe(true);
		expect(hash?.ruleOverrides).toEqual({ witch: { canPoisonSelf: true } });
		const roles = await Promise.all([1, 2, 3].map((s) => room.currentRoleOfSeat(code, s)));
		expect(roles.sort()).toEqual(['平民', '普通狼人', '预言家'].sort());
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
		expect(roles.sort()).toEqual(['平民', '普通狼人', '预言家'].sort());
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
		expect(await room.currentRoleOfSeat(code, 1)).toBe('预言家');
		expect(await room.currentRoleOfSeat(code, 3)).toBe('普通狼人');
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
