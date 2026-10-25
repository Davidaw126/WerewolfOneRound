// Keeps the screen awake while a game room is open.
//
// An auto-locking phone is the root of several "it just stopped working"
// reports: iOS WebKit stops speech synthesis the moment the screen locks
// (killing the host's narration mid-night), and drops the WebSocket within
// seconds (so a player's one-shot turn prompt can arrive while they're
// offline). Players naturally set phones down during the night, so the
// default 30s auto-lock is hit constantly.
//
// The Screen Wake Lock API is supported in Safari 16.4+ (and Chrome/Edge).
// The browser releases the lock whenever the page is hidden, so it's
// re-requested each time the page becomes visible again. Some engines also
// require a user gesture for the first request, so it's retried on taps.

type Sentinel = { released: boolean; release(): Promise<void> };

let sentinel: Sentinel | null = null;
let wanted = false;

async function acquire(): Promise<void> {
	if (!wanted || document.hidden) return;
	if (sentinel && !sentinel.released) return;
	const wl = (
		navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<Sentinel> } }
	).wakeLock;
	if (!wl) return;
	try {
		sentinel = await wl.request('screen');
	} catch {
		// Not allowed right now (no gesture yet, low battery mode, ...) -
		// the next tap or visibility change tries again.
		sentinel = null;
	}
}

const onVisibility = () => {
	if (!document.hidden) void acquire();
};
const onTap = () => void acquire();

/** Starts keeping the screen awake; returns a function that stops it. */
export function keepScreenAwake(): () => void {
	if (typeof window === 'undefined') return () => {};
	wanted = true;
	void acquire();
	document.addEventListener('visibilitychange', onVisibility);
	document.addEventListener('pointerdown', onTap, { capture: true });
	return () => {
		wanted = false;
		document.removeEventListener('visibilitychange', onVisibility);
		document.removeEventListener('pointerdown', onTap, { capture: true });
		const s = sentinel;
		sentinel = null;
		if (s && !s.released) void s.release().catch(() => {});
	};
}
