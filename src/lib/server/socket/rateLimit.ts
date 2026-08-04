import { redis } from '../redis';

declare module 'ioredis' {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars -- required to match ioredis's declaration-merge signature
	interface RedisCommander<Context> {
		rateLimitHit(key: string, windowSeconds: string, max: string): Promise<number>;
	}
}

// KEYS[1] = rate limit key. ARGV[1] = window (seconds), ARGV[2] = max hits per window.
// Atomically increments the counter for this session's current window, arming
// its expiry only on the window's first hit (an unconditional EXPIRE on every
// call would keep pushing the window forward and never actually reset it).
// Returns 1 if this hit is within budget, 0 if the sender is over the limit.
const RATE_LIMIT_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
	redis.call('EXPIRE', KEYS[1], ARGV[1])
end
if current > tonumber(ARGV[2]) then
	return 0
end
return 1
`;

redis.defineCommand('rateLimitHit', { numberOfKeys: 1, lua: RATE_LIMIT_LUA });

const rateLimitKey = (sessionId: string) => `wolf:ratelimit:${sessionId}`;

// One shared budget across every action kind, not a per-kind breakdown -
// simple, and the failure mode this guards against (a scripted client
// hammering the socket) doesn't care which action it spams. Generous enough
// that no legitimate player - even rapidly hopping seats or re-casting a
// vote - should ever hit it; tight enough to blunt a spam script.
const RATE_LIMIT_WINDOW_SECONDS = 10;
const RATE_LIMIT_MAX_ACTIONS = 30;

/** True if this session is still within its action-rate budget for the
 * current window - false if it should be rejected as sending too fast. */
export async function checkRateLimit(sessionId: string): Promise<boolean> {
	const allowed = await redis.rateLimitHit(
		rateLimitKey(sessionId),
		String(RATE_LIMIT_WINDOW_SECONDS),
		String(RATE_LIMIT_MAX_ACTIONS)
	);
	return allowed === 1;
}
