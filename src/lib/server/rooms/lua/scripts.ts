// Lua source embedded as string constants rather than read from disk at
// runtime: this module is pulled into two separate builds (SvelteKit's own
// adapter-node build, for +page.server.ts route guards, and the standalone
// esbuild bundle for the Socket.IO server) and neither reliably preserves a
// plain-text asset's path relative to the bundled module's own location.
// Embedding sidesteps that entirely.

// KEYS[1] = seatsKey, KEYS[2] = playersKey, KEYS[3] = identitiesKey, KEYS[4] = roomKey
// ARGV[1] = sessionId, ARGV[2] = newSeat (string), ARGV[3] = username, ARGV[4] = ttlSeconds
// Atomically: reject outright unless the room is still in SEATING and not yet
// locked - seat changes have no business succeeding once the game has moved
// past seating (a stray/late/replayed SeatTake mid-night would otherwise
// silently relocate whichever role sits at that seat, thanks to the swap
// below, with nobody renotified). Otherwise: reject if the seat is occupied
// by someone else, else vacate the caller's previous seat (if any) and claim
// the new one, in one round-trip so two clients tapping the same seat can
// never both succeed. If this is a seat SWITCH (not a first-time claim), the
// player's already-dealt role travels with them by swapping the identities
// entries for the old and new seat - a player can never get a different role
// by hopping to a different seat.
export const TAKE_SEAT_LUA = `
local seatsKey = KEYS[1]
local playersKey = KEYS[2]
local identitiesKey = KEYS[3]
local roomKey = KEYS[4]
local sessionId = ARGV[1]
local newSeat = ARGV[2]
local username = ARGV[3]
local ttl = tonumber(ARGV[4])

local phase = redis.call('HGET', roomKey, 'phase')
local lockStatus = redis.call('HGET', roomKey, 'lockStatus')
if phase ~= 'SEATING' or lockStatus == '1' then
	return cjson.encode({ ok = false, error = 'seating_closed' })
end

local occupant = redis.call('HGET', seatsKey, newSeat)
if occupant and occupant ~= '' and occupant ~= sessionId then
	return cjson.encode({ ok = false, error = 'seat_taken' })
end

-- Reject if some OTHER session already seated in this room is using the same
-- display name - two identically-named seats are genuinely ambiguous (in the
-- seat circle, the vote board, the night-death announcement) and, worse, a
-- name that happens to collide with the host's is indistinguishable from the
-- host client-side. Excludes the caller's own existing entry so re-seating
-- under your own name is never blocked.
local allPlayers = redis.call('HGETALL', playersKey)
for i = 1, #allPlayers, 2 do
	local otherSessionId = allPlayers[i]
	if otherSessionId ~= sessionId then
		local otherPlayer = cjson.decode(allPlayers[i + 1])
		if otherPlayer.username == username then
			return cjson.encode({ ok = false, error = 'name_taken' })
		end
	end
end

local playerRaw = redis.call('HGET', playersKey, sessionId)
local oldSeat = nil
if playerRaw then
	local player = cjson.decode(playerRaw)
	oldSeat = player.seat
end

if oldSeat and tostring(oldSeat) ~= newSeat then
	redis.call('HDEL', seatsKey, tostring(oldSeat))

	local oldRole = redis.call('HGET', identitiesKey, tostring(oldSeat))
	local newRole = redis.call('HGET', identitiesKey, newSeat)
	if oldRole then
		redis.call('HSET', identitiesKey, newSeat, oldRole)
	end
	if newRole then
		redis.call('HSET', identitiesKey, tostring(oldSeat), newRole)
	end
end

redis.call('HSET', seatsKey, newSeat, sessionId)
redis.call(
	'HSET',
	playersKey,
	sessionId,
	cjson.encode({ username = username, seat = tonumber(newSeat) })
)
redis.call('EXPIRE', seatsKey, ttl)
redis.call('EXPIRE', playersKey, ttl)
redis.call('EXPIRE', identitiesKey, ttl)

return cjson.encode({ ok = true })
`;

// KEYS[1] = seatsKey, KEYS[2] = playersKey
// ARGV[1] = sessionId
// Vacates whatever seat this session currently holds (if any) so a player who
// leaves mid-SEATING doesn't linger as a ghost occupant blocking both their
// seat and their name (via TAKE_SEAT_LUA's name check) for everyone else
// still in the room. No-op if the session never took a seat (e.g. leaving
// straight from LOBBY, before seats exist).
export const LEAVE_SEAT_LUA = `
local seatsKey = KEYS[1]
local playersKey = KEYS[2]
local sessionId = ARGV[1]

local playerRaw = redis.call('HGET', playersKey, sessionId)
if not playerRaw then
	return cjson.encode({ ok = true, vacated = false })
end

local player = cjson.decode(playerRaw)
if player.seat then
	redis.call('HDEL', seatsKey, tostring(player.seat))
end
redis.call('HDEL', playersKey, sessionId)

return cjson.encode({ ok = true, vacated = true })
`;

// KEYS[1] = roomKey, KEYS[2] = identitiesKey, KEYS[3] = seatsKey,
// KEYS[4] = deadSeatsKey, KEYS[5] = votesKey, KEYS[6] = coupleSeatsKey,
// KEYS[7] = revealedKey
// ARGV[1] = sessionId, ARGV[2] = roleConfigJson, ARGV[3] = numberOfSeats,
// ARGV[4] = identitiesJson (precomputed by dealCards() in TS - shuffling
// itself is pure TS logic, this script only needs to write it atomically),
// ARGV[5] = ttlSeconds, ARGV[6] = cupidPoisonBlocksHunter ('0'/'1')
//
// Guards phase === LOBBY so a client can't reassign themselves host mid-game
// by resubmitting the config form - the concrete fix for the old app's real
// host-hijack gap, which had no such guard at all.
export const SUBMIT_ROOM_CONFIG_LUA = `
local roomKey = KEYS[1]
local identitiesKey = KEYS[2]
local seatsKey = KEYS[3]
local deadSeatsKey = KEYS[4]
local votesKey = KEYS[5]
local coupleSeatsKey = KEYS[6]
local revealedKey = KEYS[7]

local sessionId = ARGV[1]
local roleConfigJson = ARGV[2]
local numberOfSeats = ARGV[3]
local identitiesJson = ARGV[4]
local ttl = tonumber(ARGV[5])
local cupidPoisonBlocksHunter = ARGV[6]

local phase = redis.call('HGET', roomKey, 'phase')
if phase and phase ~= '' and phase ~= 'LOBBY' then
	return cjson.encode({ ok = false, error = 'game_already_started' })
end

redis.call(
	'HSET',
	roomKey,
	'phase',
	'SEATING',
	'hostSessionId',
	sessionId,
	'roleConfig',
	roleConfigJson,
	'numberOfSeats',
	numberOfSeats,
	'lockStatus',
	'0',
	'nightNumber',
	'0',
	'stageIndex',
	'0',
	'stageOrder',
	'[]',
	'currentStage',
	'',
	'winner',
	'',
	'hunterShotSeat',
	'',
	'hunterShotResolved',
	'0',
	'witchUsedAntidote',
	'0',
	'witchUsedPoison',
	'0',
	'guardLastSeat',
	'',
	'cupidPoisonBlocksHunter',
	cupidPoisonBlocksHunter
)

redis.call('DEL', identitiesKey)
local identities = cjson.decode(identitiesJson)
for seat, role in pairs(identities) do
	redis.call('HSET', identitiesKey, seat, role)
end

redis.call('DEL', seatsKey)
redis.call('DEL', deadSeatsKey)
redis.call('DEL', votesKey)
redis.call('DEL', coupleSeatsKey)
redis.call('DEL', revealedKey)

redis.call('EXPIRE', roomKey, ttl)
redis.call('EXPIRE', identitiesKey, ttl)

return cjson.encode({ ok = true })
`;

// KEYS[1] = roomKey
// ARGV[1] = expectedCurrentStageIndex, ARGV[2] = newStageIndex, ARGV[3] = ttlSeconds
//
// Compare-and-set on stageIndex so an auto-trigger (all living holders acted)
// and a host force-skip landing in the same tick can't both advance. Only
// moves the cursor within the night's already-computed stageOrder array -
// starting a NEW night's order is a separate, server-only operation
// (setStageOrder), not raced by concurrent client actions.
export const ADVANCE_STAGE_LUA = `
local roomKey = KEYS[1]
local expectedIndex = ARGV[1]
local newIndex = ARGV[2]
local ttl = tonumber(ARGV[3])

local current = redis.call('HGET', roomKey, 'stageIndex')
if current ~= expectedIndex then
	return cjson.encode({ ok = false, error = 'stale_stage', current = current })
end

redis.call('HSET', roomKey, 'stageIndex', newIndex)
redis.call('EXPIRE', roomKey, ttl)
return cjson.encode({ ok = true })
`;

// KEYS[1] = roomKey
// ARGV[1] = ttlSeconds
// Exactly-once guard against a double-submit from a flaky reconnect. Caller
// (TS) must verify the requesting session is actually the authorized shooter
// BEFORE calling this - this script only prevents the same shot resolving twice.
export const HUNTER_SHOT_LUA = `
local roomKey = KEYS[1]
local ttl = tonumber(ARGV[1])

local resolved = redis.call('HGET', roomKey, 'hunterShotResolved')
if resolved == '1' then
	return 0
end

redis.call('HSET', roomKey, 'hunterShotResolved', '1')
redis.call('EXPIRE', roomKey, ttl)
return 1
`;
