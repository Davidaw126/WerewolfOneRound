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

const port = Number(process.env.PORT ?? 3000);

const server = createServer(handler);
attachSocketIO(server);

server.listen(port, () => {
	console.log(`listening on http://localhost:${port}`);
});
