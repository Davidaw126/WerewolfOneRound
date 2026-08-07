// Production entrypoint. Local dev uses the Vite dev plugin (devPlugin.ts)
// instead - this file is bundled by esbuild (`npm run build`, see
// package.json's "build:server" script) into build-server/index.js, which is
// what `npm run start` actually runs. It's bundled rather than run directly
// via Node's native TypeScript support specifically so extensionless
// relative imports (the normal TS convention, used throughout src/lib/server)
// resolve correctly - Node's own ESM loader requires explicit file
// extensions and doesn't do the bundler-style resolution TypeScript assumes.
import { createServer } from 'node:http';
import { handler } from '../build/handler.js';
import { attachSocketIO } from '../src/lib/server/socket/index';
import { closeRedisConnections } from '../src/lib/server/redis';

const port = Number(process.env.PORT ?? 3000);

const server = createServer(handler);
const io = attachSocketIO(server);

server.listen(port, () => {
	console.log(`listening on http://localhost:${port}`);
});

// Every redeploy sends SIGTERM before killing the process - without this,
// that hard-kills every open connection and whatever request was mid-flight
// (a vote, a night action) instead of letting the platform's own grace
// period (Render/Railway both give ~10s before SIGKILL) drain them first.
// server.close() stops accepting new HTTP connections but, per Node's docs,
// does NOT close existing keep-alive/upgraded (i.e. Socket.IO) ones - io.close()
// handles those explicitly. closeRedisConnections() lets the process exit as
// soon as everything's drained rather than always waiting out the forced-exit
// backstop below - ioredis connections otherwise stay open indefinitely.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`${signal} received, shutting down gracefully`);
	server.close(() => console.log('http server closed'));
	io.close(() => console.log('socket.io server closed'));
	closeRedisConnections().then(() => console.log('redis connections closed'));
	setTimeout(() => {
		console.log('shutdown grace period elapsed, forcing exit');
		process.exit(0);
	}, 8000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
