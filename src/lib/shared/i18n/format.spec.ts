import { describe, it, expect } from 'vitest';
import { formatRefusal } from './format';
import { en } from './en';
import type { ActionErrorCode } from '../actionErrors';

describe('formatRefusal', () => {
	it('tells a night-rule refusal from the rule texts', () => {
		expect(formatRefusal({ ok: false, error: 'seer_no_self_check' }, 'en')).toBe(
			en.nightPrompt.ruleMessages.seer_no_self_check
		);
	});

	it('tells a room refusal from the general texts', () => {
		expect(formatRefusal({ ok: false, error: 'room_locked' }, 'zh')).toBe('房间已锁定，无法加入');
	});

	it('tells a refused start from its first setup issue, with its numbers', () => {
		const text = formatRefusal(
			{
				ok: false,
				error: 'E01',
				issues: [{ code: 'E01', params: { numberOfSeats: 7, playerCount: 6 } }]
			},
			'en'
		);
		expect(text).toContain('(7)');
		expect(text).toContain('(6)');
	});

	it('falls back for a code from a newer server', () => {
		const unknown = 'kicked_by_future' as ActionErrorCode;
		expect(formatRefusal({ ok: false, error: unknown }, 'en')).toBe(en.errors.fallback);
	});
});
