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

// Registration has no sessionId yet - that's what's being created - so it's
// limited by client IP instead, with its own (tighter, longer-window) budget.
// Shares the same underlying Lua command as the socket-action limiter above.
// 60, not 10: a whole table registers within the same minute from one wifi
// (one public IP), and behind Render's proxy - without ADDRESS_HEADER set -
// every visitor even shares the proxy's address. 10 turned away the 11th
// and 12th player of a full game.
const REGISTER_RATE_LIMIT_WINDOW_SECONDS = 60;
const REGISTER_RATE_LIMIT_MAX_ATTEMPTS = 60;

/** True if this client IP is still within its registration-attempt budget
 * for the current window. */
export async function checkRegisterRateLimit(clientAddress: string): Promise<boolean> {
	const allowed = await redis.rateLimitHit(
		`wolf:ratelimit:register:${clientAddress}`,
		String(REGISTER_RATE_LIMIT_WINDOW_SECONDS),
		String(REGISTER_RATE_LIMIT_MAX_ATTEMPTS)
	);
	return allowed === 1;
}
