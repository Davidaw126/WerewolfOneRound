// Turns the engine's IO-agnostic EngineEffect[] into actual socket emits,
// translating RoleId -> the old wire Role string (roleBridge.ts) and
// reshaping a couple of payloads whose field names/shapes predate the
// engine rewrite (SeerResult.isWolf, NightResolved's bare seat-number list)
// so the client - untouched by M1 - keeps seeing exactly the same contract
// it always has.
//
// Two effect kinds are deliberately NOT handled here, by design:
//   - 'PhaseChanged' - the new engine's Phase enum has no 1:1 old-Phase
//     mapping without GameState context (DAWN, HUNTER_SHOOT's two branches -
//     see projection.ts's mapToLegacyPhase). The IO shell emits this itself,
//     from the final state, after every action - see gameSync.ts.
//   - 'NightActionRejected' - the old app surfaced a rejected night action
//     through the socket ACK (`{ok:false,error}`), never a pushed event.
//     handleNightSubmitAction pulls this out of the effect list itself
//     before calling into this translator.

import type { Death, EngineEffect, RoleId } from '../../game/types';
import type { NightStage as LegacyNightStage } from '../../shared/gameTypes';
import type { PrivateInfo } from '../../shared/events';
import type { Role } from '../../shared/roles';
import { emitToRoom, emitToSession } from '../socket/emit';
import { findSessionInSeat, readRoomHash } from '../rooms/roomRepo';
import { toPublicStage } from './projection';
import { roleIdToLegacy } from '../../game/roleBridge';

function legacyStage(stage: unknown): LegacyNightStage | null {
	const s = stage as { kind: 'ROLE_TURN'; role: RoleId } | { kind: 'COUPLE_REVEAL' } | null;
	if (!s) return null;
	if (s.kind === 'COUPLE_REVEAL') return { kind: 'COUPLE_REVEAL' };
	return { kind: 'ROLE_TURN', role: roleIdToLegacy(s.role) };
}

async function emitPrivate(code: string, seat: number, event: PrivateInfo): Promise<void> {
	const sessionId = await findSessionInSeat(code, seat);
	// A seat with nobody connected (disconnected mid-game) legitimately has no
	// live session to deliver a private effect to - not an error, just nobody
	// there to tell.
	if (sessionId) emitToSession(sessionId, event);
}

/** S4: the host-only counterpart to emitToRoom - for information (which role
 * is acting, that a role just submitted) that would out a role's holder if
 * every player received it. */
async function emitToHost(code: string, event: PrivateInfo): Promise<void> {
	const room = await readRoomHash(code);
	if (room?.hostSessionId) emitToSession(room.hostSessionId, event);
}

export async function translateEffects(code: string, effects: EngineEffect[]): Promise<void> {
	for (const effect of effects) {
		const payload = effect.payload as { kind: string } & Record<string, unknown>;

		switch (payload.kind) {
			case 'PhaseChanged':
			case 'NightActionRejected':
				continue;

			case 'HostOverrideApplied':
				if (payload.overrideKind === 'SET_ROLE') {
					const seat = payload.seat as number;
					const [playerSession, room] = await Promise.all([
						findSessionInSeat(code, seat),
						readRoomHash(code)
					]);
					if (playerSession)
						emitToSession(playerSession, { kind: 'RoleChangedByHost', seat, forYou: true });
					if (room?.hostSessionId && room.hostSessionId !== playerSession)
						emitToSession(room.hostSessionId, { kind: 'RoleChangedByHost', seat, forYou: false });
					continue;
				}
				emitToRoom(code, {
					kind: 'HostOverrideApplied',
					seat: payload.seat as number,
					overrideKind: payload.overrideKind as 'KILL' | 'REVIVE' | 'SET_ROLE',
					deaths: (payload.deaths as number[] | undefined) ?? []
				});
				continue;

			case 'StageChanged': {
				const stage = legacyStage(payload.stage);
				// S4: everyone gets the redacted (role-less) form; the host also
				// gets a private, full copy (with role) so JudgeAudioPlayer knows
				// what to narrate - see PublicNightStage's own comment.
				emitToRoom(code, { kind: 'StageChanged', stage: toPublicStage(stage) });
				await emitToHost(code, { kind: 'HostStageChanged', stage });
				continue;
			}

			case 'NightAnnouncePending':
				emitToRoom(code, { kind: 'NightAnnouncePending' });
				continue;

			case 'LastWordsSpeakerChanged':
				emitToRoom(code, {
					kind: 'LastWordsSpeakerChanged',
					seat: payload.seat as number | null
				});
				continue;

			case 'DiscussionSpeakerChanged':
				emitToRoom(code, {
					kind: 'DiscussionSpeakerChanged',
					seat: payload.seat as number | null,
					order: payload.order as number[]
				});
				continue;

			case 'DayDecided':
				emitToRoom(code, { kind: 'DayDecided' });
				continue;

			case 'DayOut':
				emitToRoom(code, {
					kind: 'DayOut',
					seats: payload.seats as number[],
					followDeaths: payload.followDeaths as number[]
				});
				continue;

			case 'SelfExploded':
				emitToRoom(code, { kind: 'SelfExploded', seat: payload.seat as number });
				continue;

			case 'KnightDuelResolved':
				emitToRoom(code, {
					kind: 'KnightDuelResolved',
					knightSeat: payload.knightSeat as number,
					targetSeat: payload.targetSeat as number,
					targetWasWolf: payload.targetWasWolf as boolean,
					deaths: payload.deaths as number[]
				});
				continue;

			case 'NightResultsAnnounced': {
				const deaths = payload.deaths as Death[];
				// The old wire event only ever carried WHO died, never why - keep
				// that exact privacy property (see nightResolution.ts's DeathCause
				// tracking, which is server-internal only for now).
				emitToRoom(code, {
					kind: 'NightResolved',
					nightNumber: payload.nightNumber as number,
					deaths: deaths.map((d) => d.seat).sort((a, b) => a - b)
				});
				continue;
			}

			case 'HunterPending':
				emitToRoom(code, { kind: 'HunterPending', hunterSeat: payload.hunterSeat as number });
				continue;

			case 'HunterAuthorized':
				await emitPrivate(code, effect.seat!, { kind: 'HunterAuthorized' });
				continue;

			case 'PackKillChosen':
				await emitPrivate(code, effect.seat!, {
					kind: 'PackKillChosen',
					bySeat: payload.bySeat as number,
					target: payload.target as number | null
				});
				continue;

			case 'RoleDoneByOther':
				await emitPrivate(code, effect.seat!, { kind: 'RoleDoneByOther' });
				continue;

			case 'StageConfirmed':
				await emitPrivate(code, effect.seat!, { kind: 'StageConfirmed' });
				continue;

			case 'ShotStatus':
				await emitPrivate(code, effect.seat!, {
					kind: 'ShotStatus',
					canShoot: payload.canShoot as boolean
				});
				continue;

			case 'HunterDenied':
				await emitPrivate(code, effect.seat!, {
					kind: 'HunterDenied',
					reason: payload.reason as 'poison'
				});
				continue;

			case 'HunterResolved':
				emitToRoom(code, {
					kind: 'HunterResolved',
					hunterSeat: payload.hunterSeat as number,
					shotSeat: payload.shotSeat as number | null,
					followDeathSeat: payload.followDeathSeat as number | null
				});
				continue;

			case 'DayResolved': {
				const identity = payload.identity as RoleId | null;
				const followDeathIdentity = payload.followDeathIdentity as RoleId | null;
				const pkCandidates = payload.pkCandidates as number[] | undefined;
				emitToRoom(code, {
					kind: 'DayResolved',
					eliminatedSeat: payload.eliminatedSeat as number | null,
					identity: identity ? roleIdToLegacy(identity) : null,
					tie: payload.tie as boolean,
					followDeathSeat: payload.followDeathSeat as number | null,
					followDeathIdentity: followDeathIdentity ? roleIdToLegacy(followDeathIdentity) : null,
					// Previously dropped here, so every client treated the flipped
					// idiot as dead: gone from every night-target list (wolves,
					// witch, guard, seer) for the rest of the game.
					...(payload.idiotRevealed === true ? { idiotRevealed: true } : {}),
					...(pkCandidates ? { pkCandidates } : {})
				});
				continue;
			}

			case 'VoteUpdated':
				emitToRoom(code, {
					kind: 'VoteUpdated',
					votedSeats: payload.votedSeats as number[],
					totalVoters: payload.totalVoters as number
				});
				continue;

			case 'GameOver': {
				const winnerMap = { GOOD: 'villagers', WEREWOLF: 'wolves', LOVERS: 'lovers' } as const;
				const identities = payload.identities as Record<number, RoleId>;
				const legacyIdentities: Record<number, ReturnType<typeof roleIdToLegacy>> = {};
				for (const [seat, role] of Object.entries(identities)) {
					legacyIdentities[Number(seat)] = roleIdToLegacy(role);
				}
				emitToRoom(code, {
					kind: 'GameOver',
					winner: winnerMap[payload.winner as 'GOOD' | 'WEREWOLF' | 'LOVERS'],
					identities: legacyIdentities,
					coupleSeats: payload.coupleSeats as [number, number] | null
				});
				continue;
			}

			case 'NightActionAck':
				await emitToHost(code, {
					kind: 'NightActionAck',
					role: roleIdToLegacy(payload.role as RoleId)
				});
				continue;

			case 'YourRole':
				await emitPrivate(code, effect.seat!, {
					kind: 'YourRole',
					role: roleIdToLegacy(payload.role as RoleId)
				});
				continue;

			case 'SeerResult':
				await emitPrivate(code, effect.seat!, {
					kind: 'SeerResult',
					targetSeat: payload.targetSeat as number,
					isWolf: payload.isBad as boolean
				});
				continue;

			case 'CoupleRevealed':
				await emitPrivate(code, effect.seat!, {
					kind: 'CoupleRevealed',
					partnerSeat: payload.partnerSeat as number
				});
				continue;

			case 'ThiefChoice': {
				const buried = payload.buried as RoleId[];
				// PrivateInfo's ThiefChoice wants a fixed 2-tuple; the engine's
				// buried array is only ever 0 or 2 entries (see startGame's
				// thiefExtraCards), but the null-vs-tuple split still needs
				// spelling out for TS.
				const legacyBuried: [Role, Role] | null =
					buried.length === 2 ? [roleIdToLegacy(buried[0]), roleIdToLegacy(buried[1])] : null;
				if (!legacyBuried) continue;
				await emitPrivate(code, effect.seat!, { kind: 'ThiefChoice', buried: legacyBuried });
				continue;
			}

			case 'YourTurnPrompt': {
				const context = payload.context as { seat: number } & Record<string, unknown>;
				await emitPrivate(code, effect.seat!, {
					kind: 'YourTurnPrompt',
					role: roleIdToLegacy(payload.role as RoleId),
					context,
					...(payload.replay === true ? { replay: true } : {})
				});
				continue;
			}

			default:
				// Not thrown: an unmapped future effect kind (e.g. a new payload
				// added to engine.ts without updating this switch) should degrade
				// to "silently not delivered" for that one effect, not take the
				// whole action down for every player in the room.
				console.error(`[effectTranslator] unhandled effect payload kind: ${payload.kind}`);
		}
	}
}
