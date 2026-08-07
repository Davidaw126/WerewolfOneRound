import { json } from '@sveltejs/kit';
import { redis } from '$lib/server/redis';
import type { RequestHandler } from './$types';

// A deploy platform's liveness/readiness probe target - checks Redis
// reachability specifically (not just "did the process boot"), since a
// live-but-Redis-less process can still accept connections but fail every
// real request.
export const GET: RequestHandler = async () => {
	try {
		await redis.ping();
		return json({ ok: true, redis: 'up' });
	} catch (err) {
		return json({ ok: false, redis: 'down', error: (err as Error).message }, { status: 503 });
	}
};
