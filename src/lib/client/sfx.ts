// The host phone's spoken narration (Web Speech API). There is no other
// audio at all: no sound effects and no night ambience. The synthesized
// forest ambience was removed because, on iPhone, a running Web Audio context
// fights speechSynthesis for the audio session - lines were sometimes cut off
// or never started. All browser-only; no-ops during SSR.

/** The user's voice toggle (AudioToggleButtons). */
let voiceMuted = false;

export function setEffectsEnabled(on: boolean): void {
	voiceMuted = !on;
	// An utterance's volume is fixed when speak() is called, so muting mid-line
	// otherwise lets it finish out loud. Cancelling is only safe once onstart
	// has already fired: JudgeAudioPlayer relays that to the server, and every
	// OTHER player's turn prompt stays hidden until it arrives - cancelling
	// first would cost the whole room the 8s reveal fallback.
	if (voiceMuted && startedFired && typeof window !== 'undefined' && window.speechSynthesis) {
		speechSynthesis.cancel();
	}
}

// --- narration via the Web Speech API ---------------------------------------
// Browser text-to-speech, not a media file - lets narration cover any event
// (not just a fixed set of recorded clips) and gives independent pitch/rate
// knobs on the utterance itself (unlike HTMLMediaElement.playbackRate, which
// ties the two together). Voice character/quality depends on what the
// browser/OS provides - there is no way to route it through the Web Audio
// effects used elsewhere in this file, since browsers don't expose
// speechSynthesis output as a capturable audio stream.

import type { Lang } from '$lib/shared/i18n';

const cachedVoices: Partial<Record<Lang, SpeechSynthesisVoice>> = {};
let voicesListenerAdded = false;

/** Picks the best installed voice for `lang`. Mandarin specifically for zh:
 * a bare startsWith('zh') happily lands on zh-HK (Cantonese) or zh-TW, which
 * on iPhones is often listed first. Only a real hit is cached - Safari fills
 * getVoices() in lazily and doesn't reliably fire voiceschanged, so an empty
 * list must be retried on the next line rather than cached as "no voice". */
function pickVoice(lang: Lang): SpeechSynthesisVoice | null {
	if (typeof window === 'undefined' || !window.speechSynthesis) return null;
	const cached = cachedVoices[lang];
	if (cached) return cached;

	const voices = speechSynthesis.getVoices();
	if (voices.length === 0) {
		if (!voicesListenerAdded) {
			voicesListenerAdded = true;
			speechSynthesis.addEventListener?.('voiceschanged', () => {
				for (const key of Object.keys(cachedVoices)) delete cachedVoices[key as Lang];
			});
		}
		return null;
	}
	const norm = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().replace('_', '-');
	const preferred = lang === 'zh' ? ['zh-cn', 'zh-hans', 'cmn'] : ['en-us', 'en-gb', 'en'];
	let voice: SpeechSynthesisVoice | undefined;
	for (const prefix of preferred) {
		const matches = voices.filter((v) => norm(v).startsWith(prefix));
		// Local voices work offline and start faster than network ones.
		voice = matches.find((v) => v.localService) ?? matches[0];
		if (voice) break;
	}
	if (!voice && lang === 'zh') voice = voices.find((v) => norm(v).startsWith('zh'));
	if (voice) cachedVoices[lang] = voice;
	return voice ?? null;
}

/** Whether this browser can speak at all. Some in-app browsers (WeChat, a few
 * Android webviews) have no speechSynthesis. */
export function speechSupported(): boolean {
	return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

let speechPrimed = false;
/** A priming utterance is out and hasn't started/failed yet. */
let primeInFlight = false;

/** Whether a gesture has actually unlocked speech on this device (the
 * priming utterance really started) - not merely that one was attempted. */
export function isSpeechPrimed(): boolean {
	return speechPrimed;
}

/**
 * Must be called synchronously from inside a user gesture (pointerdown,
 * click). iOS WebKit (Safari, and Chrome/Firefox on iPhone, which are WebKit
 * underneath) refuses to start speech synthesis until a gesture-initiated
 * speak() has happened; after that, lines triggered by socket events play
 * normally. The priming utterance must be NON-empty - WebKit silently drops a
 * whitespace-only utterance without counting it as the unlock (and without
 * firing onend). It's spoken directly, not via the queue, so it never costs
 * the queue's 3s gap. Safe to call on every gesture: after the first time it
 * only nudges a paused engine back to life.
 */
export function primeSpeech(): void {
	if (!speechSupported()) return;
	if (speechSynthesis.paused) speechSynthesis.resume();
	// iOS 17+: put the page's audio session in "playback" so the voice isn't
	// silenced by the ring/silent switch.
	const nav = navigator as Navigator & { audioSession?: { type: string } };
	if (nav.audioSession) {
		try {
			nav.audioSession.type = 'playback';
		} catch {
			/* older engines throw on unknown values */
		}
	}
	// Only counts once it actually starts. iOS silently refuses a speak()
	// from an event that isn't a real activation (pointerdown/touchstart
	// aren't - touchend/click are), and marking it primed on the attempt
	// meant every later tap skipped the retry: no voice until something
	// spoke straight from a click (the 上帝之手 test button).
	if (speechPrimed || primeInFlight) return;
	primeInFlight = true;
	const u = new SpeechSynthesisUtterance('.');
	u.volume = 0;
	u.rate = 2;
	keepAlive.add(u);
	u.onstart = () => {
		speechPrimed = true;
	};
	u.onend = () => {
		speechPrimed = true;
		primeInFlight = false;
		keepAlive.delete(u);
	};
	u.onerror = () => {
		primeInFlight = false;
		keepAlive.delete(u);
	};
	// A refused speak() may fire nothing at all - let the next tap retry.
	setTimeout(() => (primeInFlight = false), 1500);
	speechSynthesis.speak(u);
}

/** Strong references to in-flight utterances. Both Chrome and Safari can
 * garbage-collect a SpeechSynthesisUtterance that nothing references while
 * it's still speaking - its onstart/onend then never fire, which wedged this
 * queue until the 15s stuck-timer, and (because onstart is what relays
 * NightNarrationStarted) held every other player's turn prompt back until
 * its 8s fallback. */
const keepAlive = new Set<SpeechSynthesisUtterance>();

// Native back-to-back speechSynthesis.speak() calls queue with NO gap between
// them, so consecutive lines ran straight into each other. This hand-rolled
// queue instead waits for each utterance to actually finish (onend/onerror),
// then holds a deliberate pause, before starting the next one. 3s matches the
// server's own POST_ACTION_PAUSE_MS - the one place these two calls can fire
// back-to-back with no real-world gap in between is the very start of a
// night/day (a phase announcement immediately followed by the first role's
// wake-up call, both arriving off the same server transition), so this floor
// is what actually enforces "wait 3s" there specifically.
interface NarrationItem {
	text: string;
	lang: Lang;
	onStart?: () => void;
	/** Lines sharing a tag can be dropped together while still queued - see
	 * dropQueuedNarration. */
	tag?: string;
}

const narrationQueue: NarrationItem[] = [];
let speaking = false;
/** When cancel() last ran - WebKit and Chrome both drop a speak() issued
 * immediately after cancel(), so the next line waits a beat. */
let lastCancelAt = 0;
const POST_CANCEL_DELAY_MS = 250;
/** If a line hasn't started speaking by this point, the engine almost
 * certainly refused it (not unlocked, backgrounded) - relay its start signal
 * anyway so the rest of the room isn't held up waiting on silence. */
const START_GRACE_MS = 2500;
let startGraceTimer: ReturnType<typeof setTimeout> | null = null;
/** A line that still hasn't started this long after speak() was refused -
 * the voice is blocked (a mobile browser lost the unlock, e.g. after being
 * backgrounded). Longer than START_GRACE_MS so a slow voice isn't flagged. */
const BLOCKED_AFTER_MS = 5000;
let blockedTimer: ReturnType<typeof setTimeout> | null = null;
let onBlocked: (() => void) | null = null;

/** Called when the voice turns out to be blocked, so the host can be asked
 * to tap the screen once - the next tap re-unlocks it (primeSpeech). */
export function onSpeechBlocked(cb: (() => void) | null): void {
	onBlocked = cb;
}
/** Whether the utterance currently in flight has already fired onstart (and
 * therefore already relayed its signal to the server). Only then is it safe to
 * cancel it - see setEffectsEnabled. */
let startedFired = false;
const NARRATION_GAP_MS = 3000;

/** Ceiling on how long any single utterance is allowed to run before this
 * module gives up on it and moves on anyway - see the timer set in
 * speakNext() below. No line this app ever queues (role call-outs, death
 * announcements, etc.) takes anywhere near this long to actually speak. */
const MAX_UTTERANCE_MS = 15000;
let stuckTimer: ReturnType<typeof setTimeout> | null = null;

/** Shared by the utterance's own onend/onerror AND the stuck-timer fallback
 * below - either way, the queue must move on exactly once per utterance. */
function clearTimers(): void {
	if (stuckTimer) {
		clearTimeout(stuckTimer);
		stuckTimer = null;
	}
	if (startGraceTimer) {
		clearTimeout(startGraceTimer);
		startGraceTimer = null;
	}
}

function finishCurrent(): void {
	clearTimers();
	speaking = false;
	startedFired = false;
	setTimeout(speakNext, NARRATION_GAP_MS);
}

function speakNext(): void {
	if (speaking) return;
	if (narrationQueue.length === 0) return;
	const sinceCancel = Date.now() - lastCancelAt;
	if (sinceCancel < POST_CANCEL_DELAY_MS) {
		setTimeout(speakNext, POST_CANCEL_DELAY_MS - sinceCancel);
		return;
	}
	const item = narrationQueue.shift()!;
	speaking = true;
	startedFired = false;

	const utter = new SpeechSynthesisUtterance(item.text);
	const voice = pickVoice(item.lang);
	if (voice) utter.voice = voice;
	utter.lang = voice?.lang ?? (item.lang === 'zh' ? 'zh-CN' : 'en-US');
	utter.pitch = 0.6; // deeper, independent of rate
	utter.rate = 0.8;
	// Muting is volume-only, never an early return: the utterance must still
	// run so onstart still fires, because the rest of the room's turn prompts
	// are gated on the signal it relays.
	utter.volume = voiceMuted ? 0 : 1;
	// onStart must fire exactly once per line, whichever comes first: the
	// engine's real onstart, or the grace timer below.
	let relayed = false;
	const relayStart = () => {
		if (relayed) return;
		relayed = true;
		item.onStart?.();
	};
	utter.onstart = () => {
		startedFired = true;
		if (blockedTimer) {
			clearTimeout(blockedTimer);
			blockedTimer = null;
		}
		speechPrimed = true;
		if (startGraceTimer) {
			clearTimeout(startGraceTimer);
			startGraceTimer = null;
		}
		relayStart();
	};
	const done = () => {
		keepAlive.delete(utter);
		// A stale event from an utterance already given up on (stuck timer,
		// stopNarration) must not finish whatever is speaking now.
		if (current !== utter) return;
		current = null;
		relayStart();
		finishCurrent();
	};
	utter.onend = done;
	utter.onerror = done;
	keepAlive.add(utter);
	current = utter;
	// Chrome (and occasionally Safari) can leave the engine paused after the
	// page was backgrounded; a paused engine queues forever without speaking.
	if (speechSynthesis.paused) speechSynthesis.resume();
	speechSynthesis.speak(utter);
	startGraceTimer = setTimeout(relayStart, START_GRACE_MS);
	if (blockedTimer) clearTimeout(blockedTimer);
	blockedTimer = setTimeout(() => {
		blockedTimer = null;
		if (current !== utter || startedFired || voiceMuted) return;
		// Never started: drop the stuck line, forget the unlock so the very
		// next tap primes again, and tell the host.
		speechPrimed = false;
		primeInFlight = false;
		lastCancelAt = Date.now();
		speechSynthesis.cancel();
		current = null;
		finishCurrent();
		onBlocked?.();
	}, BLOCKED_AFTER_MS);

	// Many mobile browsers silently kill speech synthesis when the tab/app is
	// backgrounded, WITHOUT ever firing onend/onerror - pause()/resume() and
	// narrationWatchdog() below both rely on the engine honestly reporting its
	// own state, which is exactly what doesn't happen in that failure mode.
	// This timer doesn't trust the engine's state at all: if an utterance has
	// been "in flight" unreasonably long, force the queue to move on
	// regardless of what speechSynthesis claims.
	stuckTimer = setTimeout(() => {
		if (speaking && current === utter) {
			current = null;
			keepAlive.delete(utter);
			relayStart();
			finishCurrent();
		}
	}, MAX_UTTERANCE_MS);
}

/** The utterance this queue is currently waiting on, if any. */
let current: SpeechSynthesisUtterance | null = null;

/** speechSynthesis.pause()/resume() is unreliable across engines, and a long
 * pause can swallow the terminal onend entirely - leaving `speaking` stuck true
 * and the queue wedged for the rest of the game. Called on re-show to unstick
 * it: if we think we're speaking but the engine disagrees, move on - skipping
 * the usual NARRATION_GAP_MS pause (unlike finishCurrent) since the user was
 * just away for who-knows-how-long already; no need to make them wait
 * further on top of that. Faster than waiting on MAX_UTTERANCE_MS above when
 * the engine's own state IS trustworthy - that timer is the fallback for
 * when it isn't. */
export function narrationWatchdog(): void {
	if (typeof window === 'undefined' || !window.speechSynthesis) return;
	if (speaking && !speechSynthesis.speaking && !speechSynthesis.pending) {
		clearTimers();
		if (current) keepAlive.delete(current);
		current = null;
		speaking = false;
		startedFired = false;
		speakNext();
	}
}

/** Queues a line of narration with a deliberate gap after whatever's already
 * queued/speaking, instead of running straight into it. `onStart`, if given,
 * fires the moment THIS line actually starts being spoken (not when it's
 * merely queued) - callers that gate UI on narration timing rely on this. If
 * speech isn't going to happen at all (unsupported browser), `onStart` fires
 * immediately instead, so that gating degrades open rather than hanging. */
export function narrate(text: string, lang: Lang, onStart?: () => void, tag?: string): void {
	if (typeof window === 'undefined' || !window.speechSynthesis) {
		onStart?.();
		return;
	}
	narrationQueue.push({ text, lang, onStart, tag });
	speakNext();
}

/** Removes still-queued (not yet speaking) lines with this tag. A role's
 * call-out that hasn't started by the time its turn is over would otherwise
 * play during a LATER role's turn - and every line after it shifts later
 * too, so by mid-night of round 2+ the voice was calling roles out of step. */
export function dropQueuedNarration(tag: string): void {
	for (let i = narrationQueue.length - 1; i >= 0; i--) {
		if (narrationQueue[i].tag === tag) narrationQueue.splice(i, 1);
	}
}

/** Cuts off whatever narration is currently queued/speaking, if any. */
export function stopNarration(): void {
	if (typeof window === 'undefined' || !window.speechSynthesis) return;
	clearTimers();
	narrationQueue.length = 0;
	current = null;
	speaking = false;
	startedFired = false;
	lastCancelAt = Date.now();
	speechSynthesis.cancel();
}
