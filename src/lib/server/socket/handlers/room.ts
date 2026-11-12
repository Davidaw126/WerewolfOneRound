// Room actions: who is asking, and this socket's own channel bookkeeping.
// What each operation changes and who hears about it is roomOps.ts.

import * as ops from '../../rooms/roomOps';
import { roomChannel, removeSessionFromRoom } from '../emit';
import type { RuleConfigOverrides } from '../../../game/ruleSwitches';
import type { RoleId } from '../../../game/types';
import type { AckResponse, ActionReply } from '../../../shared/events';
import { requireRoomCode, type GameSocket } from './helpers';

function enterChannel(socket: GameSocket, code: string): void {
	// Into another room without leaving the last one (back to the lobby from
	// a finished game): stop hearing the old room, on every phone of this
	// session. Their seat there stays theirs until they Leave it.
	const previous = socket.data.roomCode;
	if (previous && previous !== code) removeSessionFromRoom(socket.data.sessionId, previous);
	socket.data.roomCode = code;
	socket.join(roomChannel(code));
}

export async function handleRoomCreate(socket: GameSocket): Promise<ActionReply<'RoomCreate'>> {
	const reply = await ops.openRoom(socket.data.sessionId);
	if (reply.ok) enterChannel(socket, reply.roomCode);
	return reply;
}

/** Entering a room - the first time, or again after a page reload. */
export async function handleRoomJoin(
	socket: GameSocket,
	roomCode: string
): Promise<ActionReply<'RoomJoin'>> {
	const reply = await ops.enterRoom(roomCode, socket.data.sessionId);
	if (reply.ok) enterChannel(socket, roomCode);
	return reply;
}

/** A phone back from a dropped connection or the background. */
export async function handleResync(socket: GameSocket): Promise<ActionReply<'ResyncRequest'>> {
	const code = await requireRoomCode(socket);
	// A reconnect is a new socket: put it back in the room's channel.
	enterChannel(socket, code);
	return ops.catchUp(code, socket.data.sessionId);
}

export async function handleRoomSubmitConfig(
	socket: GameSocket,
	roleConfig: Partial<Record<RoleId, number>>,
	ruleOverrides?: RuleConfigOverrides
): Promise<ActionReply<'RoomSubmitConfig'>> {
	const code = await requireRoomCode(socket);
	return ops.submitConfig(code, socket.data.sessionId, roleConfig, ruleOverrides);
}

export async function handleRoomStartGame(socket: GameSocket): Promise<AckResponse> {
	return ops.startGame(await requireRoomCode(socket), socket.data.sessionId);
}

export async function handleRoomRerollRoles(socket: GameSocket): Promise<AckResponse> {
	return ops.rerollRoles(await requireRoomCode(socket), socket.data.sessionId);
}

export async function handleRoomStopGame(socket: GameSocket): Promise<AckResponse> {
	return ops.stopGame(await requireRoomCode(socket), socket.data.sessionId);
}

export async function handleRoomLeave(socket: GameSocket): Promise<AckResponse> {
	const reply = await ops.leave(await requireRoomCode(socket), socket.data.sessionId);
	socket.data.roomCode = null;
	return reply;
}
