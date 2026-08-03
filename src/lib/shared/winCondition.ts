import { roleTeam, type Role } from './roles';

/**
 * Villagers win when zero living seats hold a wolf-team role; wolves win when
 * living wolves >= living non-wolves. Call this after every death event (night
 * resolution, day-vote elimination, hunter revenge-shot), not just once per cycle.
 */
export function checkWin(livingRoles: Role[]): 'wolves' | 'villagers' | null {
	const wolves = livingRoles.filter((r) => roleTeam(r) === 'wolf').length;
	const nonWolves = livingRoles.length - wolves;
	if (wolves === 0) return 'villagers';
	if (wolves >= nonWolves) return 'wolves';
	return null;
}
