// Shared between hooks.server.ts, the register endpoint, and the Socket.IO
// auth middleware - all three need to agree on the exact cookie name.
export const SESSION_COOKIE_NAME = 'wolf_session';
