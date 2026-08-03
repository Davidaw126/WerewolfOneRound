export const ROOM_TTL_SECONDS = 6 * 60 * 60; // 6h - abandoned rooms just expire, no sweeper needed

export const roomKey = (code: string) => `wolf:room:${code}`;
export const seatsKey = (code: string) => `wolf:room:${code}:seats`;
export const playersKey = (code: string) => `wolf:room:${code}:players`;
export const identitiesKey = (code: string) => `wolf:room:${code}:identities`;
export const deadSeatsKey = (code: string) => `wolf:room:${code}:deadSeats`;
export const votesKey = (code: string) => `wolf:room:${code}:votes`;
export const coupleSeatsKey = (code: string) => `wolf:room:${code}:coupleSeats`;
export const revealedKey = (code: string) => `wolf:room:${code}:revealed`;
export const nightActionsKey = (code: string, night: number) =>
	`wolf:room:${code}:nightActions:${night}`;

/** Every fixed per-room key (excludes the per-night nightActions key, which is
 * cleared/expired independently each night). Used to re-arm TTL in one pipeline. */
export function fixedRoomKeys(code: string): string[] {
	return [
		roomKey(code),
		seatsKey(code),
		playersKey(code),
		identitiesKey(code),
		deadSeatsKey(code),
		votesKey(code),
		coupleSeatsKey(code),
		revealedKey(code)
	];
}

export function randomRoomCode(): string {
	return String(Math.floor(Math.random() * 900000) + 100000);
}
