import { Server } from 'socket.io';
import type { Server as Http1Server } from 'node:http';
import type { Http2SecureServer } from 'node:http2';
import { createAdapter } from '@socket.io/redis-adapter';
import { redis, createRedisDuplicate } from '../redis';
import { authMiddleware } from './authMiddleware';
import { setIoInstance } from './emit';
import { dispatchAction } from './dispatch';
import { ClientActionSchema } from '../../shared/events';
import { resumeNightTimers } from '../game/gameSync';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from './types';

type AnyHttpServer = Http1Server | Http2SecureServer;

let attachedTo: AnyHttpServer | null = null;

/** Idempotent: dev mode (Vite HMR) and prod both call this, and it must be
 * safe to call more than once against the same underlying server. Accepts
 * both plain http.Server (production) and Vite dev server's broader type
 * (which can be an Http2SecureServer if HTTPS dev is configured). */
export function attachSocketIO(httpServer: AnyHttpServer): Server {
	if (attachedTo === httpServer) {
		// Already attached to this exact server instance (e.g. re-invoked by HMR).
		return (httpServer as unknown as { io: Server }).io;
	}

	const io = new Server<
		ClientToServerEvents,
		ServerToClientEvents,
		Record<string, never>,
		SocketData
	>(httpServer, {
		cors: { origin: false } // same-origin only, no cross-origin socket clients expected
	});

	io.adapter(createAdapter(redis, createRedisDuplicate()));
	io.use(authMiddleware);

	io.on('connection', (socket) => {
		socket.on('client:action', (action, ack) => {
			const parsed = ClientActionSchema.safeParse(action);
			if (!parsed.success) {
				ack?.({ ok: false, error: 'invalid_action' });
				return;
			}
			dispatchAction(socket, parsed.data)
				.then((result) => ack?.(result))
				.catch((err) => {
					console.error('action dispatch error', err);
					ack?.({ ok: false, error: 'server_error' });
				});
		});
	});

	setIoInstance(io);
	attachedTo = httpServer;
	// After a restart mid-game, pick the running nights back up.
	resumeNightTimers().catch((err) => console.error('resumeNightTimers failed', err));
	(httpServer as unknown as { io: Server }).io = io;
	return io;
}
