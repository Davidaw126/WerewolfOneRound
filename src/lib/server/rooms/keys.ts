export const ROOM_TTL_SECONDS = 6 * 60 * 60; // 6h - abandoned rooms just expire, no sweeper needed

export const roomKey = (code: string) => `wolf:room:${code}`;
export const seatsKey = (code: string) => `wolf:room:${code}:seats`;
export const playersKey = (code: string) => `wolf:room:${code}:players`;
export const identitiesKey = (code: string) => `wolf:room:${code}:identities`;
export const revealedKey = (code: string) => `wolf:room:${code}:revealed`;

// -- M1: the new engine's own persistence, separate from the RoomManager-
// scope keys above (seats/players/identities/config stay exactly as they
// were - only "what phase the game itself is in" moves into a single blob). --
export const gameStateKey = (code: string) => `wolf:room:${code}:gameState`;
export const gameLockKey = (code: string) => `wolf:room:${code}:lock`;

/** Every per-room key. Used to re-arm TTL in one pipeline and to close a room. */
export function fixedRoomKeys(code: string): string[] {
	return [
		roomKey(code),
		seatsKey(code),
		playersKey(code),
		identitiesKey(code),
		revealedKey(code),
		gameStateKey(code)
	];
}

export function randomRoomCode(): string {
	return String(Math.floor(Math.random() * 900000) + 100000);
}
