// Deliberately its own module, importing nothing: `helpers.ts` (which
// re-exports this) pulls in roomRepo.ts, and server/game/gameStateRepo.ts
// needs to throw ActionError without pulling roomRepo.ts back in - roomRepo
// is about to import FROM server/game/ (for the public-state projection),
// so helpers.ts -> roomRepo.ts -> game/* -> helpers.ts would be a real
// circular import otherwise.
export class ActionError extends Error {}
