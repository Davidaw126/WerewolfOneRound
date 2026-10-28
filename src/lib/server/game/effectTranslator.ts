// Turns the engine's typed EngineEffect[] into actual socket emits. Most
// payloads already have the wire's shape and go out as they are; this file
// only holds the ones that are reshaped or split (改变身份 to two people,
// stage redaction, night results, the winner's name, SeerResult.isWolf,
// the thief's two cards) and who each one is delivered to.
//
// Not handled here, by design:
//   - 'PhaseChanged' / 'NightAnnouncePending' - the IO shell broadcasts the
//     phase itself, from the final state, only when it really changed (see
//     gameSync.ts); DAWN is how the room learns results are pending.
//   - 'NightActionRejected' - becomes the submitter's ack error
//     (runGameAction), never a pushed event.

import type { EngineEffect } from '../../game/types';
import type { PrivateInfo } from '../../shared/events';
import { emitToRoom, emitToSession } from '../socket/emit';
import { sessionInSeat, hostSessionOf } from '../rooms/roomRepo';
import { toPublicStage, toWireWinner } from './projection';

async function emitPrivate(code: string, seat: number, event: PrivateInfo): Promise<void> {
	const sessionId = await sessionInSeat(code, seat);
	// A seat with nobody connected (disconnected mid-game) legitimately has no
	// live session to deliver a private effect to - not an error, just nobody
	// there to tell.
	if (sessionId) emitToSession(sessionId, event);
}

/** S4: the host-only counterpart to emitToRoom - for information (which role
 * is acting, that a role just submitted) that would out a role's holder if
 * every player received it. */
async function emitToHost(code: string, event: PrivateInfo): Promise<void> {
	const host = await hostSessionOf(code);
	if (host) emitToSession(host, event);
}

export async function translateEffects(code: string, effects: EngineEffect[]): Promise<void> {
	for (const effect of effects) {
		const payload = effect.payload;
		const seat = effect.seat!;

		switch (payload.kind) {
			// Broadcast by gameSync from the final state - the room learns DAWN
			// from PhaseChanged itself (see the header).
			case 'PhaseChanged':
			case 'NightAnnouncePending':
			case 'NightActionRejected':
				continue;

			// --- Sent as they are ---------------------------------------------
			case 'LastWordsSpeakerChanged':
			case 'DiscussionSpeakerChanged':
			case 'DayDecided':
			case 'DayOut':
			case 'SelfExploded':
			case 'KnightDuelResolved':
			case 'HunterPending':
			case 'HunterResolved':
			case 'DayResolved':
			case 'VoteUpdated':
				emitToRoom(code, payload);
				continue;

			case 'HunterAuthorized':
			case 'HunterDenied':
			case 'PackKillChosen':
			case 'RoleDoneByOther':
			case 'StageConfirmed':
			case 'ShotStatus':
			case 'YourRole':
			case 'CoupleRevealed':
			case 'YourTurnPrompt':
				await emitPrivate(code, seat, payload);
				continue;

			// S4: acknowledges a role's submission - to the Host only, since
			// telling the room would out that role's holder as having acted.
			case 'NightActionAck':
				await emitToHost(code, payload);
				continue;

			// --- Reshaped or split --------------------------------------------
			case 'HostOverrideApplied':
				// 改变身份 goes only to that seat's player and the Host: a
				// room-wide notice would point every player at that seat.
				if (payload.overrideKind === 'SET_ROLE') {
					const [playerSession, host] = await Promise.all([
						sessionInSeat(code, payload.seat),
						hostSessionOf(code)
					]);
					if (playerSession)
						emitToSession(playerSession, {
							kind: 'RoleChangedByHost',
							seat: payload.seat,
							forYou: true
						});
					if (host && host !== playerSession)
						emitToSession(host, { kind: 'RoleChangedByHost', seat: payload.seat, forYou: false });
					continue;
				}
				emitToRoom(code, { ...payload, deaths: payload.deaths ?? [] });
				continue;

			case 'StageChanged':
				// S4: everyone gets the redacted (role-less) form; the Host also
				// gets a private, full copy (with role) so JudgeAudioPlayer knows
				// what to narrate - see PublicNightStage's own comment.
				emitToRoom(code, { kind: 'StageChanged', stage: toPublicStage(payload.stage) });
				await emitToHost(code, { kind: 'HostStageChanged', stage: payload.stage });
				continue;

			case 'NightResultsAnnounced':
				// Only WHO died, never why - DeathCause stays server-internal.
				emitToRoom(code, {
					kind: 'NightResolved',
					nightNumber: payload.nightNumber,
					deaths: payload.deaths.map((d) => d.seat).sort((a, b) => a - b)
				});
				continue;

			case 'GameOver':
				emitToRoom(code, { ...payload, winner: toWireWinner(payload.winner) });
				continue;

			case 'SeerResult':
				await emitPrivate(code, seat, {
					kind: 'SeerResult',
					targetSeat: payload.targetSeat,
					isWolf: payload.isBad
				});
				continue;

			case 'ThiefChoice':
				// The engine's buried pile is only ever empty or 2 cards.
				if (payload.buried.length !== 2) continue;
				await emitPrivate(code, seat, {
					kind: 'ThiefChoice',
					buried: [payload.buried[0], payload.buried[1]]
				});
				continue;

			default: {
				// A new engine payload kind without a branch here fails to compile.
				const unhandled: never = payload;
				console.error('[effectTranslator] unhandled effect', unhandled);
			}
		}
	}
}
