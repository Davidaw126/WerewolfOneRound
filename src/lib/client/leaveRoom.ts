import type { Phase } from '../shared/gameTypes';

// Mirrors the server's own IN_PROGRESS_PHASES in handleRoomLeave - only these
// phases have an active turn/vote that leaving would actually break.
const IN_PROGRESS_PHASES: Phase[] = [
	'NIGHT_ACTIONS',
	'NIGHT_HUNTER_SHOT',
	'DAY_VOTE',
	'DAY_HUNTER_SHOT'
];

export function isGameInProgress(phase: Phase | undefined | null): boolean {
	return !!phase && IN_PROGRESS_PHASES.includes(phase);
}

/** Every leave (from any phase) needs a confirmation, but what it warns about
 * differs: the host leaving destroys the whole room for everyone, a normal
 * player leaving mid-round only ends the current round and empties their own
 * seat, and leaving outside of either case is low-stakes. */
export function leaveConfirmMessage(
	isHost: boolean,
	gameInProgress: boolean
): { message: string; confirmLabel: string } {
	if (isHost) {
		return {
			message: '你是房主，离开将关闭并清空整个房间，所有玩家都会被移出。确定要离开吗？',
			confirmLabel: '关闭房间并离开'
		};
	}
	if (gameInProgress) {
		return {
			message:
				'游戏正在进行中，离开将结束当前对局；你的座位会被清空，其他玩家可以继续游戏。确定要离开吗？',
			confirmLabel: '结束对局并离开'
		};
	}
	return { message: '确定要离开房间吗？', confirmLabel: '离开' };
}
