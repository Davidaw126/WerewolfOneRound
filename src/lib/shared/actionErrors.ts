// Every code an action can be refused with. Each one has its line of text in
// both languages (i18n `errors` / `nightPrompt.ruleMessages`, both typed
// from these), so a new refusal without text fails to compile.

import type { NightRuleError } from '../game/rules/nightRules';
import type { ValidationCode } from '../game/rules/setup';

/** Refusals from the room, the socket layer, and the phone itself
 * (`timeout`, `disconnected`). The engine's night-rule refusals and the
 * setup checks' E-codes are their own sets, below. */
export type RoomErrorCode =
	| 'timeout'
	| 'disconnected'
	| 'rate_limited'
	| 'server_error'
	| 'invalid_action'
	| 'invalid_phase'
	| 'game_not_started'
	| 'game_already_started'
	| 'not_host'
	| 'not_in_room'
	| 'not_seated'
	| 'room_not_found'
	| 'room_locked'
	| 'room_busy'
	| 'seat_taken'
	| 'name_taken'
	| 'seating_closed'
	| 'seats_not_locked'
	| 'empty_config'
	| 'missing_role'
	| 'no_role_assigned'
	| 'not_your_role'
	| 'not_feared'
	| 'not_authorized_shooter'
	| 'nothing_to_announce'
	| 'night_not_announced'
	| 'cannot_mark_out'
	| 'cannot_exile'
	| 'cannot_self_explode'
	| 'cannot_duel';

export type ActionErrorCode = RoomErrorCode | NightRuleError | ValidationCode;

const VALIDATION_CODE = /^E\d\d$/;

export function isValidationCode(code: ActionErrorCode): code is ValidationCode {
	return VALIDATION_CODE.test(code);
}
