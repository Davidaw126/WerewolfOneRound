// The game-action module, tested through runGameAction against a real Redis
// (database 14 - roomRepo.spec.ts has 15; test files run in parallel), with a fake Socket.IO server that
// records every message and fake timers for the night's pacing.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';

process.env.REDIS_URL = 'redis://127.0.0.1:6379/14';

const { redis, closeRedisConnections } = await import('../redis');
const room = await import('../rooms/roomRepo');
const { setIoInstance } = await import('../socket/emit');
const { runGameAction, startGameAndBroadcast } = await import('./gameSync');
const { loadGameState } = await import('./gameStateRepo');
const { buildSetup } = await import('../../game/rules/setup');
const { defaultRuleConfig } = await import('../../game/defaultRuleConfig');

type Sent = { channel: string; event: { kind: string } & Record<string, unknown> };
let sent: Sent[] = [];
setIoInstance({
	to: (channel: string) => ({
		emit: (_name: string, event: Sent['event']) => sent.push({ channel, event })
	})
} as never);

const HOST = 'host-session';
// Night order on this board: wolves, witch, seer.
const ROLES = { '1': 'WEREWOLF', '2': 'SEER', '3': 'VILLAGER', '4': 'WITCH' } as const;

/** Real time passing while setTimeout is faked: lets Redis round trips and
 * the work they trigger finish. */
async function realWait(ms: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < ms) await new Promise((r) => setImmediate(r));
}

async function step(code: string): Promise<string | null> {
	return (await loadGameState(code))?.currentStepKey ?? null;
}

/** Fast-forwards the fake clock, then lets whatever fired finish. */
async function elapse(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await realWait(150);
}

async function startedGame(): Promise<string> {
	const code = await room.createRoom(HOST);
	await room.submitRoomConfigAtomic(code, HOST, {
		roleConfig: { WEREWOLF: 1, SEER: 1, VILLAGER: 1, WITCH: 1 },
		numberOfSeats: 4,
		cupidPoisonBlocksHunter: false,
		ruleOverrides: {}
	});
	for (const seat of [1, 2, 3, 4]) await room.takeSeatAtomic(code, `s${seat}`, seat, `P${seat}`);
	await room.setSeatsLocked(code, true);
	await startGameAndBroadcast(code, {
		roomCode: code,
		ruleConfig: defaultRuleConfig(),
		setup: buildSetup({ WEREWOLF: 1, SEER: 1, VILLAGER: 1, WITCH: 1 }),
		deal: { identities: { ...ROLES }, buried: null },
		players: [1, 2, 3, 4].map((seat) => ({ seat, sessionId: `s${seat}`, nickname: `P${seat}` })),
		now: 1000
	});
	return code;
}

/** The Host taps 强制继续 until the night reaches `key`. */
async function hostAdvanceTo(code: string, key: string): Promise<void> {
	for (let i = 0; i < 10 && (await step(code)) !== key; i++) {
		await runGameAction(code, { type: 'ADVANCE_STAGE' });
	}
	expect(await step(code)).toBe(key);
}

beforeAll(async () => {
	await redis.ping();
});

beforeEach(async () => {
	expect(redis.options.db).toBe(14);
	await redis.flushdb();
	sent = [];
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
	vi.useRealTimers();
	await realWait(50);
});

afterAll(async () => {
	await closeRedisConnections();
});

describe('starting a game', () => {
	it('tells the room the phase and mirrors it into the room', async () => {
		const code = await startedGame();
		expect(sent.some((s) => s.event.kind === 'PhaseChanged')).toBe(true);
		expect((await room.readRoomHash(code))?.phase).toBe('FIRST_NIGHT');
	});
});

describe('a night turn nobody alive can take (假环节)', () => {
	it('moves on by itself, but never quicker than a real turn could', async () => {
		const code = await startedGame();
		// The witch dies (上帝之手), so her turn becomes a 假环节.
		await runGameAction(code, { type: 'HOST_OVERRIDE', kind: 'KILL', seat: 4 });
		await hostAdvanceTo(code, 'role:WITCH');
		const first = await step(code);
		await elapse(5900);
		expect(await step(code)).toBe(first);
		await elapse(10_000);
		expect(await step(code)).not.toBe(first);
	});
});

describe('a real night turn', () => {
	it('answers ok, then waits the pause before calling the next role', async () => {
		const code = await startedGame();
		await hostAdvanceTo(code, 'role:WEREWOLF');
		const ack = await runGameAction(code, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 3 }
		});
		expect(ack).toEqual({ ok: true });
		await elapse(2900);
		expect(await step(code)).toBe('role:WEREWOLF');
		await elapse(2200);
		expect(await step(code)).not.toBe('role:WEREWOLF');
	});

	it("sends the seer's result to the seer's phone only", async () => {
		const code = await startedGame();
		await hostAdvanceTo(code, 'role:SEER');
		sent = [];
		await runGameAction(code, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 2,
			role: 'SEER',
			action: { seerCheckTarget: 1 }
		});
		const results = sent.filter((s) => s.event.kind === 'SeerResult');
		expect(results.map((s) => s.channel)).toEqual(['session:s2']);
		expect(results[0].event).toMatchObject({ targetSeat: 1 });
	});

	it("a stale pause timer doesn't skip the stage the Host already moved to", async () => {
		const code = await startedGame();
		await hostAdvanceTo(code, 'role:WEREWOLF');
		await runGameAction(code, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 3 }
		});
		await runGameAction(code, { type: 'ADVANCE_STAGE' }); // Host taps 强制继续
		const next = await step(code);
		await elapse(5100); // the wolf turn's pause timer fires here
		expect(await step(code)).toBe(next);
	});
});

describe('who is dead, as the room learns it', () => {
	it('a night kill reaches no phone until the Host announces it', async () => {
		const code = await startedGame();
		await hostAdvanceTo(code, 'role:WEREWOLF');
		await runGameAction(code, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 3 }
		});
		for (let i = 0; i < 5 && (await loadGameState(code))?.phase !== 'DAWN'; i++) {
			await runGameAction(code, { type: 'ADVANCE_STAGE' });
		}
		expect((await loadGameState(code))?.phase).toBe('DAWN');
		const deathsSent = () =>
			sent.filter((s) => s.event.kind === 'DeathsUpdated').map((s) => s.event.deadSeats);
		expect(deathsSent().flat()).not.toContain(3);

		await runGameAction(code, { type: 'ANNOUNCE_NIGHT_RESULTS' });
		expect(deathsSent().at(-1)).toEqual([3]);
	});
});

describe('Host-only actions', () => {
	it('are refused for anyone else, under the lock, and change nothing', async () => {
		const code = await startedGame();
		const before = await step(code);
		const ack = await runGameAction(code, { type: 'ADVANCE_STAGE' }, { host: 's1' });
		expect(ack).toEqual({ ok: false, error: 'not_host' });
		expect(await step(code)).toBe(before);
		expect(await runGameAction(code, { type: 'ADVANCE_STAGE' }, { host: HOST })).toEqual({
			ok: true
		});
		expect(await step(code)).not.toBe(before);
	});
});

describe('answering the caller', () => {
	it("returns the engine's rule error and tells nobody", async () => {
		const code = await startedGame();
		expect(await step(code)).toBe('role:WEREWOLF');
		sent = [];
		const ack = await runGameAction(code, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 2,
			role: 'SEER',
			action: { seerCheckTarget: 1 } // during the wolves' turn
		});
		expect(ack.ok).toBe(false);
		expect(sent).toEqual([]);
		expect((await loadGameState(code))?.submittedRoles).not.toContain('SEER');
	});

	it("a refusal from the caller's check changes and logs nothing", async () => {
		const code = await startedGame();
		const logged = await redis.llen(`wolf:room:${code}:actions`);
		const ack = await runGameAction(code, () => ({ ok: false, error: 'not_your_role' }));
		expect(ack).toEqual({ ok: false, error: 'not_your_role' });
		expect(await redis.llen(`wolf:room:${code}:actions`)).toBe(logged);
	});

	it('an action the engine ignored answers the given error', async () => {
		const code = await startedGame();
		sent = [];
		const ack = await runGameAction(
			code,
			{ type: 'ANNOUNCE_NIGHT_RESULTS' },
			{ ignored: 'nothing_to_announce' }
		);
		expect(ack).toEqual({ ok: false, error: 'nothing_to_announce' });
		expect(sent).toEqual([]);
	});
});
