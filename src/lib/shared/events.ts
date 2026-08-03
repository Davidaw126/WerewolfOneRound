import { z } from 'zod';
import { ALL_ROLES, type Role } from './roles';
import type { Phase, NightStage, RoomPublicState } from './gameTypes';

// ---------------------------------------------------------------------------
// Client -> server. One socket event name ('client:action') carries all of
// these as a discriminated union, validated server-side by the matching zod
// schema before anything touches Redis. Every handler acks with {ok, error?}
// instead of firing blind, so the UI can show inline validation errors.
// ---------------------------------------------------------------------------

const roleEnum = z.enum(ALL_ROLES as unknown as [Role, ...Role[]]);

export const NightActionSubmissionSchema = z.discriminatedUnion('role', [
	z.object({ role: z.literal('普通狼人'), targetSeat: z.number().int().positive() }),
	z.object({ role: z.literal('预言家'), targetSeat: z.number().int().positive() }),
	z.object({
		role: z.literal('女巫'),
		poisonTarget: z.number().int().positive().nullable(),
		useAntidote: z.boolean()
	}),
	z.object({ role: z.literal('守卫'), targetSeat: z.number().int().positive() }),
	z.object({ role: z.literal('狼美人'), targetSeat: z.number().int().positive() }),
	z.object({
		role: z.literal('丘比特'),
		seatA: z.number().int().positive(),
		seatB: z.number().int().positive()
	}),
	z.object({ role: z.literal('盗贼'), swap: z.enum(['buried1', 'buried2']).nullable() })
]);
export type NightActionSubmission = z.infer<typeof NightActionSubmissionSchema>;

export const ClientActionSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('RoomCreate') }),
	z.object({ kind: z.literal('RoomJoin'), roomCode: z.string().regex(/^\d{6}$/) }),
	z.object({
		kind: z.literal('RoomSubmitConfig'),
		roleConfig: z.record(roleEnum, z.number().int().min(0)),
		cupidPoisonBlocksHunter: z.boolean()
	}),
	z.object({ kind: z.literal('RoomStartGame') }),
	z.object({ kind: z.literal('RoomLockSeats'), locked: z.boolean() }),
	z.object({ kind: z.literal('SeatTake'), seatNumber: z.number().int().positive() }),
	z.object({ kind: z.literal('RevealRole') }),
	z.object({ kind: z.literal('RoomRerollRoles') }),
	z.object({ kind: z.literal('RoomLeave') }),
	z.object({ kind: z.literal('RoomStopGame') }),
	z.object({ kind: z.literal('NightSubmitAction'), action: NightActionSubmissionSchema }),
	z.object({ kind: z.literal('NightAdvanceStage') }),
	z.object({ kind: z.literal('NightAnnounceResults') }),
	z.object({
		kind: z.literal('VoteCast'),
		target: z.union([z.number().int().positive(), z.literal('abstain')])
	}),
	z.object({ kind: z.literal('VoteEnd') }),
	z.object({ kind: z.literal('HunterShoot'), target: z.number().int().positive().nullable() }),
	z.object({ kind: z.literal('ResyncRequest') }),
	z.object({ kind: z.literal('NightNarrationStarted'), role: roleEnum })
]);
export type ClientAction = z.infer<typeof ClientActionSchema>;

export type AckResponse = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Server -> client, broadcast to the room (or, for PrivateInfo, to one
// session only via emitToSession - never mixed into the room broadcast).
// ---------------------------------------------------------------------------

export type ServerEvent =
	| { kind: 'StateSnapshot'; state: RoomPublicState }
	| { kind: 'SeatUpdated'; seats: RoomPublicState['seats'] }
	| { kind: 'LockUpdated'; locked: boolean }
	| { kind: 'RolesRerolled' }
	| { kind: 'GameReset' }
	| { kind: 'PhaseChanged'; phase: Phase; nightNumber: number }
	| { kind: 'StageChanged'; stage: NightStage | null }
	| { kind: 'NightActionAck'; role: Role }
	| { kind: 'NightAnnouncePending' }
	| { kind: 'NightResolved'; nightNumber: number; deaths: number[] }
	| { kind: 'VoteUpdated'; votes: Record<number, number | 'abstain'> }
	| { kind: 'DayResolved'; eliminatedSeat: number | null; identity: Role | null; tie: boolean }
	| { kind: 'HunterPending'; hunterSeat: number }
	| { kind: 'HunterResolved'; hunterSeat: number; shotSeat: number | null }
	| { kind: 'GameOver'; winner: 'wolves' | 'villagers'; identities: Record<number, Role> }
	| { kind: 'ErrorToast'; message: string }
	| { kind: 'RoomClosed'; message: string }
	| { kind: 'StageNarrationStarted'; role: Role };

/**
 * Everything the acting player needs that only the server knows, delivered
 * privately alongside their turn prompt. In a physical game the host would say
 * these things aloud to that one player with everyone else's eyes closed.
 *
 * NEVER broadcast this. Several fields (the wolf teammate list above all, but
 * also the witch's kill readout and the hunter's poison status) would expose
 * hidden information if they ever reached the room channel - it must only
 * travel via emitToSession.
 */
export interface TurnContext {
	/** The recipient's own seat. The prompt component has no other way to know
	 * it: `mySeat` is derived at the room-page level and isn't passed down. */
	seat: number;
	witch?: {
		/** Tonight's 普通狼人 target, or null if nobody was attacked. */
		killedSeat: number | null;
		/** Still unspent for the whole game. Whether it's usable *right now*
		 * additionally depends on the self-save and one-potion-per-night rules,
		 * which the UI derives and the server re-checks on submit. */
		antidoteAvailable: boolean;
		poisonAvailable: boolean;
	};
	/** Sent on every 猎人 turn: the same hunterCanShoot() verdict the server
	 * will apply if they die tonight, shown live the way a physical host gives
	 * the hunter a thumbs up or down. */
	hunter?: { canShoot: boolean };
	guard?: { lastProtectedSeat: number | null };
	/** Living wolf-team seats other than the recipient's own. */
	wolf?: { teammateSeats: number[] };
}

export type PrivateInfo =
	| { kind: 'YourRole'; role: Role }
	| { kind: 'SeerResult'; targetSeat: number; isWolf: boolean }
	| { kind: 'CoupleRevealed'; partnerSeat: number }
	| { kind: 'ThiefChoice'; buried: [Role, Role] }
	| { kind: 'YourTurnPrompt'; role: Role; context: TurnContext }
	| { kind: 'HunterAuthorized' }
	| { kind: 'HunterDenied'; reason: 'poison' };
