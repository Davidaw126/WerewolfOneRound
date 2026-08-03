import type { ClientAction, ServerEvent, PrivateInfo, AckResponse } from '../../shared/events';

export interface SocketData {
	sessionId: string;
	username: string;
	roomCode: string | null;
}

export interface ClientToServerEvents {
	'client:action': (action: ClientAction, ack: (res: AckResponse) => void) => void;
}

export interface ServerToClientEvents {
	'server:event': (event: ServerEvent) => void;
	'server:private': (event: PrivateInfo) => void;
}
