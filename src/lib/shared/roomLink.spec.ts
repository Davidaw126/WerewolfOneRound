import { describe, it, expect } from 'vitest';
import { roomPath, roomPathFrom } from './roomLink';

describe('where a new player may be sent after registering', () => {
	it('is a room’s own path', () => {
		expect(roomPathFrom(roomPath('123456'))).toBe('/room/123456');
	});

	it('is nowhere else', () => {
		for (const next of [
			null,
			'',
			'/lobby',
			'/room/12345',
			'/room/123456/x',
			'//evil.example/room/123456',
			'https://evil.example/room/123456'
		])
			expect(roomPathFrom(next)).toBeNull();
	});
});
