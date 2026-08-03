import { describe, it, expect } from 'vitest';
import { checkWin } from './winCondition';
import type { Role } from './roles';

describe('checkWin', () => {
	it('no winner while both sides have living members and wolves are outnumbered', () => {
		const living: Role[] = ['普通狼人', '普通村民', '普通村民', '预言家'];
		expect(checkWin(living)).toBeNull();
	});

	it('villagers win when zero wolves remain', () => {
		const living: Role[] = ['普通村民', '预言家', '女巫'];
		expect(checkWin(living)).toBe('villagers');
	});

	it('villagers win (empty room, degenerate case) when nobody is left', () => {
		expect(checkWin([])).toBe('villagers');
	});

	it('wolves win when they equal the remaining villagers (>=, not just >)', () => {
		const living: Role[] = ['普通狼人', '普通村民'];
		expect(checkWin(living)).toBe('wolves');
	});

	it('wolves win when they outnumber villagers', () => {
		const living: Role[] = ['普通狼人', '普通狼人', '普通村民'];
		expect(checkWin(living)).toBe('wolves');
	});

	it('wolf-team special roles count toward the wolf side', () => {
		const living: Role[] = ['白狼王', '普通村民'];
		expect(checkWin(living)).toBe('wolves');
	});

	it('1-vs-1 endgame resolves immediately as a wolf win', () => {
		const living: Role[] = ['普通狼人', '预言家'];
		expect(checkWin(living)).toBe('wolves');
	});
});
