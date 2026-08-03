import type { Plugin } from 'vite';

/** Attaches Socket.IO to Vite's own dev HTTP server, so `npm run dev` gets a
 * working realtime layer too, not just the production build (adapter-node's
 * default Node target doesn't expose a bare server for `vite dev` to reuse -
 * this plugin and the prod entrypoint in server/index.ts both funnel into
 * the same attachSocketIO() so the two never drift apart).
 *
 * The import of './index' (and everything it pulls in - $lib/shared,
 * $env/dynamic/private) is deliberately dynamic and inside configureServer,
 * not a static top-level import: vite.config.ts itself is loaded before
 * SvelteKit's $lib/$env aliases exist, so a static import here would break
 * config loading. By the time configureServer runs, the dev server's own
 * module graph (where those aliases DO resolve) is already active. */
export function socketIODevPlugin(): Plugin {
	return {
		name: 'socket-io-dev',
		async configureServer(server) {
			if (!server.httpServer) return;
			const { attachSocketIO } = await import('./index');
			attachSocketIO(server.httpServer);
		}
	};
}
