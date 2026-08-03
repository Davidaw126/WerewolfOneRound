// Deliberately NOT using SvelteKit's $env/dynamic/private here: this module
// (and everything under src/lib/server/**) must also work when executed by
// plain Node - both the production entrypoint (server/index.ts, run directly
// via `node server/index.ts`, no Vite involved) and the dev-mode Socket.IO
// plugin (loaded from vite.config.ts's own module graph, which resolves
// before SvelteKit's aliases exist). $env only works inside Vite's own
// request pipeline, neither of those contexts qualifies.
try {
	process.loadEnvFile();
} catch {
	// No .env file present - fine in real deployments, where the platform
	// injects environment variables directly instead of a checked-in file.
}

export const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

export function requireSessionSecret(): string {
	const secret = process.env.SESSION_SECRET;
	if (!secret) {
		throw new Error('SESSION_SECRET env var is required (see .env.example)');
	}
	return secret;
}
