import Redis from 'ioredis';
import { REDIS_URL } from './env';

// ioredis emits 'error' on every connection it manages (initial connect
// failures, dropped connections, etc.) - Node's EventEmitter throws and
// crashes the whole process if an 'error' event has zero listeners, so
// without this a transient network blip against Redis would take the
// entire app down instead of just logging and letting ioredis's own
// reconnect logic retry.
function logRedisError(label: string) {
	return (err: Error) => {
		console.error(`[redis] ${label} connection error:`, err);
	};
}

// Without these, a full Redis outage (not just a blip) leaves every
// in-flight command queued indefinitely - since nothing upstream (hooks,
// route handlers) wraps Redis calls in its own timeout, that means requests
// just hang instead of failing fast. maxRetriesPerRequest bounds how many
// times a queued command retries before rejecting with "max retries per
// request" instead of waiting forever; connectTimeout bounds the initial
// handshake. enableOfflineQueue stays at its default (true/on) - the
// Socket.IO Redis adapter (createRedisDuplicate below) issues its own
// SUBSCRIBE the instant it's constructed, before the connection has finished
// the initial handshake, and relies on that command being queued and flushed
// once ready rather than rejected outright.
const RESILIENCE_OPTIONS = {
	maxRetriesPerRequest: 3,
	connectTimeout: 5000
};

export const redis = new Redis(REDIS_URL, RESILIENCE_OPTIONS);
redis.on('error', logRedisError('primary'));

/** A second connection dedicated to Socket.IO's pub/sub adapter (ioredis
 * connections used for SUBSCRIBE can't also run normal commands). */
export function createRedisDuplicate() {
	const duplicate = redis.duplicate();
	duplicate.on('error', logRedisError('duplicate'));
	return duplicate;
}
