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
// KEYS[4] = revealedKey
// ARGV[1] = sessionId, ARGV[2] = roleConfigJson, ARGV[3] = numberOfSeats,
// ARGV[4] = identitiesJson (precomputed by dealCards() in TS - shuffling
// itself is pure TS logic, this script only needs to write it atomically),
// ARGV[5] = ttlSeconds, ARGV[6] = cupidPoisonBlocksHunter ('0'/'1'),
// ARGV[7] = ruleOverridesJson
//
// Guards phase === LOBBY so a client can't reassign themselves host mid-game
// by resubmitting the config form - the concrete fix for the old app's real
// host-hijack gap, which had no such guard at all.
export const SUBMIT_ROOM_CONFIG_LUA = `
local roomKey = KEYS[1]
local identitiesKey = KEYS[2]
local seatsKey = KEYS[3]
local revealedKey = KEYS[4]

local sessionId = ARGV[1]
local roleConfigJson = ARGV[2]
local numberOfSeats = ARGV[3]
local identitiesJson = ARGV[4]
local ttl = tonumber(ARGV[5])
local cupidPoisonBlocksHunter = ARGV[6]
local ruleOverridesJson = ARGV[7]

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
	'cupidPoisonBlocksHunter',
	cupidPoisonBlocksHunter,
	'ruleOverrides',
	ruleOverridesJson
)

redis.call('DEL', identitiesKey)
local identities = cjson.decode(identitiesJson)
for seat, role in pairs(identities) do
	redis.call('HSET', identitiesKey, seat, role)
end

redis.call('DEL', seatsKey)
redis.call('DEL', revealedKey)

redis.call('EXPIRE', roomKey, ttl)
redis.call('EXPIRE', identitiesKey, ttl)

return cjson.encode({ ok = true })
`;

// ADVANCE_STAGE_LUA and HUNTER_SHOT_LUA (the old stageIndex/stageEpoch CAS
// and the hunterShotResolved exactly-once guard) retired in M1: both
// concerns are now handled by the new engine's own per-room lock
// (gameStateRepo.ts's withGameLock) around every load -> reduce -> save
// cycle, which makes both kinds of race structurally impossible rather than
// needing a narrow, field-specific guard for each one.
