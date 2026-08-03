import Redis from 'ioredis';
import { REDIS_URL } from './env';

export const redis = new Redis(REDIS_URL);

/** A second connection dedicated to Socket.IO's pub/sub adapter (ioredis
 * connections used for SUBSCRIBE can't also run normal commands). */
export function createRedisDuplicate() {
	return redis.duplicate();
}
