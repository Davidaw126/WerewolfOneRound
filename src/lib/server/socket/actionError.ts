// Deliberately its own module, importing only a type: `helpers.ts` (which
// re-exports this) pulls in roomRepo.ts, and server/game/gameStateRepo.ts
// needs to throw ActionError without pulling roomRepo.ts back in - roomRepo
// is about to import FROM server/game/ (for the public-state projection),
// so helpers.ts -> roomRepo.ts -> game/* -> helpers.ts would be a real
// circular import otherwise.
import type { ActionErrorCode } from '../../shared/actionErrors';

export class ActionError extends Error {
	constructor(readonly code: ActionErrorCode) {
		super(code);
	}
}
