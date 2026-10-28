// Who hears what: the effect translator's delivery rules, against a real
// Redis (database 13 - the other server specs use 14 and 15) and a fake io
// that records every message with its channel.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';

process.env.REDIS_URL = 'redis://127.0.0.1:6379/13';

const { redis, closeRedisConnections } = await import('../redis');
const room = await import('../rooms/roomRepo');
const { setIoInstance } = await import('../socket/emit');
const { translateEffects } = await import('./effectTranslator');

type Sent = { channel: string; event: { kind: string } & Record<string, unknown> };
let sent: Sent[] = [];
setIoInstance({
	to: (channel: string) => ({
		emit: (_name: string, event: Sent['event']) => sent.push({ channel, event })
	})
} as never);

const HOST = 'host-session';
let code = '';

beforeEach(async () => {
	expect(redis.options.db).toBe(13);
	await redis.flushdb();
	sent = [];
	code = await room.createRoom(HOST);
	await room.submitRoomConfigAtomic(code, HOST, {
		roleConfig: { WEREWOLF: 1, SEER: 1, VILLAGER: 1 },
		numberOfSeats: 3,
		cupidPoisonBlocksHunter: false,
		ruleOverrides: {}
	});
	for (const seat of [1, 2, 3]) await room.takeSeatAtomic(code, `s${seat}`, seat, `P${seat}`);
});

afterAll(async () => {
	await closeRedisConnections();
});

const ROOM = () => `room:${code}`;

describe('delivery', () => {
	it('a 改变身份 reaches only that player and the Host, never the room', async () => {
		await translateEffects(code, [
			{
				kind: 'BROADCAST',
				payload: { kind: 'HostOverrideApplied', seat: 2, overrideKind: 'SET_ROLE' }
			}
		]);
		expect(sent.map((s) => [s.channel, s.event.forYou])).toEqual([
			['session:s2', true],
			[`session:${HOST}`, false]
		]);
	});

	it('the room sees that a turn is on, only the Host sees whose', async () => {
		await translateEffects(code, [
			{
				kind: 'BROADCAST',
				payload: { kind: 'StageChanged', stage: { kind: 'ROLE_TURN', role: 'SEER' } }
			}
		]);
		const toRoom = sent.find((s) => s.channel === ROOM());
		const toHost = sent.find((s) => s.channel === `session:${HOST}`);
		expect(toRoom?.event).toEqual({ kind: 'StageChanged', stage: { kind: 'ROLE_TURN' } });
		expect(toHost?.event).toEqual({
			kind: 'HostStageChanged',
			stage: { kind: 'ROLE_TURN', role: 'SEER' }
		});
	});

	it('night results say who died, never why', async () => {
		await translateEffects(code, [
			{
				kind: 'BROADCAST',
				payload: {
					kind: 'NightResultsAnnounced',
					nightNumber: 1,
					deaths: [
						{ seat: 3, cause: 'WITCH_POISON' },
						{ seat: 1, cause: 'WOLF_KILL' }
					]
				}
			}
		]);
		expect(sent).toEqual([
			{ channel: ROOM(), event: { kind: 'NightResolved', nightNumber: 1, deaths: [1, 3] } }
		]);
	});

	it('a private effect goes to the seat holder only, and a submission ack to the Host only', async () => {
		await translateEffects(code, [
			{ kind: 'PRIVATE', seat: 1, payload: { kind: 'YourRole', role: 'WEREWOLF' } },
			{ kind: 'BROADCAST', payload: { kind: 'NightActionAck', role: 'SEER' } }
		]);
		expect(sent.map((s) => s.channel)).toEqual(['session:s1', `session:${HOST}`]);
	});

	it('a rule rejection and the phase are not sent from here', async () => {
		await translateEffects(code, [
			{ kind: 'PRIVATE', seat: 1, payload: { kind: 'NightActionRejected', error: 'x' } },
			{ kind: 'BROADCAST', payload: { kind: 'PhaseChanged', phase: 'DAWN', nightNumber: 1 } }
		]);
		expect(sent).toEqual([]);
	});
});
