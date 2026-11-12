// Who hears what: the effect translator's delivery rules, with a fake io
// that records every message with its channel.
import { describe, it, expect, beforeEach } from 'vitest';
import { setIoInstance } from '../socket/emit';
import { translateEffects, type Recipients } from './effectTranslator';

type Sent = { channel: string; event: { kind: string } & Record<string, unknown> };
let sent: Sent[] = [];
setIoInstance({
	to: (channel: string) => ({
		emit: (_name: string, event: Sent['event']) => sent.push({ channel, event })
	})
} as never);

const HOST = 'host-session';
const code = '123456';
const TO: Recipients = { host: HOST, sessionOfSeat: { 1: 's1', 2: 's2', 3: 's3' } };

beforeEach(() => {
	sent = [];
});

const ROOM = () => `room:${code}`;

describe('delivery', () => {
	it('a 改变身份 reaches only that player and the Host, never the room', () => {
		translateEffects(
			code,
			[
				{
					kind: 'BROADCAST',
					payload: { kind: 'HostOverrideApplied', seat: 2, overrideKind: 'SET_ROLE' }
				}
			],
			TO
		);
		expect(sent.map((s) => [s.channel, s.event.forYou])).toEqual([
			['session:s2', true],
			[`session:${HOST}`, false]
		]);
	});

	it('the room sees that a turn is on, only the Host sees whose', () => {
		translateEffects(
			code,
			[
				{
					kind: 'BROADCAST',
					payload: { kind: 'StageChanged', stage: { kind: 'ROLE_TURN', role: 'SEER' } }
				}
			],
			TO
		);
		const toRoom = sent.find((s) => s.channel === ROOM());
		const toHost = sent.find((s) => s.channel === `session:${HOST}`);
		expect(toRoom?.event).toEqual({ kind: 'StageChanged', stage: { kind: 'ROLE_TURN' } });
		expect(toHost?.event).toEqual({
			kind: 'HostStageChanged',
			stage: { kind: 'ROLE_TURN', role: 'SEER' }
		});
	});

	it('night results say who died, never why', () => {
		translateEffects(
			code,
			[
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
			],
			TO
		);
		expect(sent).toEqual([
			{ channel: ROOM(), event: { kind: 'NightResolved', nightNumber: 1, deaths: [1, 3] } }
		]);
	});

	it('a private effect goes to the seat holder only, and a submission ack to the Host only', () => {
		translateEffects(
			code,
			[
				{ kind: 'PRIVATE', seat: 1, payload: { kind: 'YourRole', role: 'WEREWOLF' } },
				{ kind: 'BROADCAST', payload: { kind: 'NightActionAck', role: 'SEER' } }
			],
			TO
		);
		expect(sent.map((s) => s.channel)).toEqual(['session:s1', `session:${HOST}`]);
	});

	it('a rule rejection and the phase are not sent from here', () => {
		translateEffects(
			code,
			[
				{
					kind: 'PRIVATE',
					seat: 1,
					payload: { kind: 'NightActionRejected', error: 'already_submitted' }
				},
				{ kind: 'BROADCAST', payload: { kind: 'PhaseChanged', phase: 'DAWN', nightNumber: 1 } }
			],
			TO
		);
		expect(sent).toEqual([]);
	});
});
