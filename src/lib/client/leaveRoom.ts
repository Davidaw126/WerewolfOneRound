import type { Phase } from '../shared/gameTypes';
import { strings, type Lang } from '../shared/i18n';

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
	gameInProgress: boolean,
	lang: Lang
): { message: string; confirmLabel: string } {
	const t = strings(lang).leaveRoom;
	if (isHost) {
		return { message: t.hostWarning, confirmLabel: t.hostConfirmLabel };
	}
	if (gameInProgress) {
		return { message: t.midGameWarning, confirmLabel: t.midGameConfirmLabel };
	}
	return { message: t.simpleConfirm, confirmLabel: t.simpleConfirmLabel };
}
