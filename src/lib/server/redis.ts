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

export const redis = new Redis(REDIS_URL);
redis.on('error', logRedisError('primary'));

/** A second connection dedicated to Socket.IO's pub/sub adapter (ioredis
 * connections used for SUBSCRIBE can't also run normal commands). */
export function createRedisDuplicate() {
	const duplicate = redis.duplicate();
	duplicate.on('error', logRedisError('duplicate'));
	return duplicate;
}
