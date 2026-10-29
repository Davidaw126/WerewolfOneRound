// The Host's voice: everything about the Host phone speaking - whether
// speech is unlocked on this device, the queue of lines with a pause between
// them, telling the server when a role's call-out actually starts, and
// noticing a phone that has stopped speaking. There is no other audio in the
// app: on iPhone a running Web Audio context fights speechSynthesis for the
// audio session (lines cut off or never start).
//
// It speaks through a SpeechEngine: the browser's speechSynthesis (below), or
// a fake in tests (hostVoice.spec.ts) driven with fake timers - the iPhone
// failure modes (a refused line, a lost onend, a paused engine) are
// reproduced there instead of only on a real phone.

import type { Lang } from '$lib/shared/i18n';

export interface UtteranceEvents {
	onstart: () => void;
	onend: () => void;
	/** Refused or cut off (cancel) - over, without having finished. */
	onerror: () => void;
}

export interface SpeechEngine {
	readonly supported: boolean;
	/** Starts speaking `text` at once, ahead of nothing (the queue is ours). */
	speak(
		text: string,
		opts: { lang: Lang; volume: number; rate: number; pitch?: number },
		events: UtteranceEvents
	): void;
	cancel(): void;
	/** Wakes an engine left paused (a page that was in the background). */
	resume(): void;
	/** Whether the engine says it is speaking or has something queued. */
	readonly busy: boolean;
	/** iOS: plays through the silent switch. */
	usePlaybackSession(): void;
}

export interface VoiceLine {
	text: string;
	lang: Lang;
	/** Fires once, when this line actually starts - or, if speech isn't going
	 * to happen, straight away, so nothing waiting on it hangs. */
	onStart?: () => void;
	/** Lines sharing a tag can be dropped together while still queued. */
	tag?: string;
}

/** The pause between lines. Matches the server's pause after an action: the
 * start of a night (its announcement, then the first role's call-out, both
 * from one transition) is where back-to-back lines otherwise run together. */
export const GAP_MS = 3000;
/** WebKit and Chrome drop a speak() issued right after cancel(). */
const AFTER_CANCEL_MS = 250;
/** A line not started by now was most likely refused: its start is relayed
 * anyway, so the rest of the room isn't held up waiting on silence. */
export const START_GRACE_MS = 2500;
/** A line still not started by now: the voice is blocked (the phone lost the
 * unlock, e.g. after the background). Longer than the grace, so a slow
 * voice isn't flagged. */
export const BLOCKED_AFTER_MS = 5000;
/** No line runs this long; past it the queue moves on whatever the engine
 * claims (mobile engines can drop onend when backgrounded). */
export const MAX_LINE_MS = 15000;
/** A refused unlock may fire nothing at all - let the next tap retry. */
const PRIME_RETRY_MS = 1500;

/** Where unlocking speech stands on this device. */
export type Unlock =
	/** No tap yet: a line now would only be refused. */
	| 'locked'
	/** A tap tried to unlock; it hasn't been seen to work yet. */
	| 'tried'
	/** A line (or the unlock itself) has actually started speaking. */
	| 'unlocked';

export class HostVoice {
	unlock: Unlock = 'locked';
	private muted = false;
	private primeInFlight = false;
	private queue: VoiceLine[] = [];
	/** The line in flight - a token for telling its events from stale ones. */
	private current: object | null = null;
	private currentStarted = false;
	/** Sends the current line's start, if it hasn't gone yet. */
	private relayCurrent: (() => void) | null = null;
	private lastCancelAt = -Infinity;
	private timers = new Set<ReturnType<typeof setTimeout>>();
	private blockedHandler: (() => void) | null = null;
	private warnedLocked = false;

	constructor(private readonly engine: SpeechEngine) {}

	get supported(): boolean {
		return this.engine.supported;
	}

	/** Told when the voice is blocked - asks the Host for one tap. */
	onBlocked(handler: (() => void) | null): void {
		this.blockedHandler = handler;
	}

	/**
	 * Call from inside a tap (its END: iOS only accepts touchend / click /
	 * pointerup as activations). iOS WebKit refuses speech until a
	 * gesture-started speak() has happened; a silent but NON-empty line does
	 * it (a whitespace-only one is dropped without counting). Safe on every
	 * tap: once unlocked it only nudges a paused engine awake.
	 */
	prime(): void {
		if (!this.engine.supported) return;
		this.engine.resume();
		this.engine.usePlaybackSession();
		if (this.unlock === 'unlocked' || this.primeInFlight) return;
		if (this.unlock === 'locked') this.unlock = 'tried';
		this.primeInFlight = true;
		this.engine.speak(
			'.',
			{ lang: 'en', volume: 0, rate: 2 },
			{
				onstart: () => (this.unlock = 'unlocked'),
				onend: () => {
					this.unlock = 'unlocked';
					this.primeInFlight = false;
				},
				onerror: () => (this.primeInFlight = false)
			}
		);
		// Not one of the line timers: a line finishing mustn't clear it.
		setTimeout(() => (this.primeInFlight = false), PRIME_RETRY_MS);
	}

	/** The voice toggle. A muted line still runs (at volume 0): its start is
	 * what lets every other phone show its turn. A line already speaking is
	 * cut only once its start has gone out. */
	setMuted(muted: boolean): void {
		this.muted = muted;
		if (muted && this.currentStarted) this.engine.cancel();
	}

	/** Queues a line after whatever is queued or speaking. */
	say(line: VoiceLine): void {
		if (!this.engine.supported) {
			line.onStart?.();
			return;
		}
		if (this.unlock === 'locked') {
			// No tap since the page loaded (a reload mid-game): the line would
			// be refused. Don't make anyone wait on it; say so once.
			line.onStart?.();
			if (!this.warnedLocked && !this.muted) {
				this.warnedLocked = true;
				this.blockedHandler?.();
			}
			return;
		}
		this.queue.push(line);
		this.next();
	}

	/** Drops still-queued lines with this tag. A role's call-out not started
	 * by the end of its turn would otherwise play during a later turn, and
	 * push every line after it later too. */
	drop(tag: string): void {
		this.queue = this.queue.filter((l) => l.tag !== tag);
	}

	/** Cuts off everything queued or speaking. */
	stop(): void {
		if (!this.engine.supported) return;
		this.clearTimers();
		this.queue = [];
		this.current = null;
		this.currentStarted = false;
		this.cancel();
	}

	/** Back from the background: an engine that dropped a line without
	 * saying so (no onend) would hold the queue until MAX_LINE_MS - if we
	 * think a line is speaking but the engine disagrees, move on now, without
	 * the usual gap (the Host was away long enough). */
	wake(): void {
		if (!this.engine.supported) return;
		this.engine.resume();
		if (this.current && !this.engine.busy) {
			this.relayCurrent?.();
			this.clearTimers();
			this.current = null;
			this.currentStarted = false;
			this.next();
		}
	}

	private next(): void {
		if (this.current || this.queue.length === 0) return;
		const sinceCancel = Date.now() - this.lastCancelAt;
		if (sinceCancel < AFTER_CANCEL_MS) {
			this.later(() => this.next(), AFTER_CANCEL_MS - sinceCancel);
			return;
		}
		const line = this.queue.shift()!;
		const token = {};
		this.current = token;
		this.currentStarted = false;

		// The line's start goes out exactly once: on the engine's onstart, or
		// when the engine gives up on it, whichever comes first.
		let relayed = false;
		const relayStart = () => {
			if (relayed) return;
			relayed = true;
			line.onStart?.();
		};
		this.relayCurrent = relayStart;
		const finish = (gap: number) => {
			if (this.current !== token) return;
			this.clearTimers();
			this.current = null;
			this.currentStarted = false;
			relayStart();
			this.later(() => this.next(), gap);
		};

		this.engine.resume();
		this.engine.speak(
			line.text,
			{ lang: line.lang, volume: this.muted ? 0 : 1, rate: 0.8, pitch: 0.6 },
			{
				onstart: () => {
					if (this.current !== token) return;
					this.currentStarted = true;
					this.unlock = 'unlocked';
					relayStart();
				},
				onend: () => finish(GAP_MS),
				onerror: () => finish(GAP_MS)
			}
		);
		this.later(relayStart, START_GRACE_MS);
		this.later(() => {
			if (this.current !== token || this.currentStarted || this.muted) return;
			// Never started: drop the line, forget the unlock so the next tap
			// tries again, and ask the Host for that tap.
			this.unlock = 'tried';
			this.primeInFlight = false;
			this.cancel();
			finish(GAP_MS);
			this.blockedHandler?.();
		}, BLOCKED_AFTER_MS);
		this.later(() => finish(GAP_MS), MAX_LINE_MS);
	}

	private cancel(): void {
		this.lastCancelAt = Date.now();
		this.engine.cancel();
	}

	private later(fn: () => void, ms: number): void {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			fn();
		}, ms);
		this.timers.add(timer);
	}

	private clearTimers(): void {
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
	}
}

/** The browser's speechSynthesis. A no-op engine during SSR or in a browser
 * without speech (WeChat, some Android webviews). */
export function browserSpeech(): SpeechEngine {
	const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
	// Chrome and Safari can garbage-collect an utterance nothing references
	// while it's still speaking - its onstart/onend then never fire.
	const keepAlive = new Set<SpeechSynthesisUtterance>();
	return {
		supported: !!synth,
		speak(text, opts, events) {
			if (!synth) return;
			const u = new SpeechSynthesisUtterance(text);
			const voice = pickVoice(synth, opts.lang);
			if (voice) u.voice = voice;
			u.lang = voice?.lang ?? (opts.lang === 'zh' ? 'zh-CN' : 'en-US');
			u.volume = opts.volume;
			u.rate = opts.rate;
			if (opts.pitch !== undefined) u.pitch = opts.pitch;
			u.onstart = events.onstart;
			u.onend = () => {
				keepAlive.delete(u);
				events.onend();
			};
			u.onerror = () => {
				keepAlive.delete(u);
				events.onerror();
			};
			keepAlive.add(u);
			synth.speak(u);
		},
		cancel: () => synth?.cancel(),
		resume() {
			if (synth?.paused) synth.resume();
		},
		get busy() {
			return !!synth && (synth.speaking || synth.pending);
		},
		usePlaybackSession() {
			const nav = navigator as Navigator & { audioSession?: { type: string } };
			if (!nav.audioSession) return;
			try {
				nav.audioSession.type = 'playback';
			} catch {
				/* older engines throw on unknown values */
			}
		}
	};
}

const cachedVoices: Partial<Record<Lang, SpeechSynthesisVoice>> = {};
let voicesListenerAdded = false;

/** The best installed voice for `lang`: Mandarin for zh (a bare 'zh' match
 * lands on Cantonese or zh-TW, often listed first on iPhones), a local voice
 * before a network one. Only a real hit is cached - Safari fills the list in
 * lazily without reliably firing voiceschanged, so an empty list is retried
 * on the next line. */
function pickVoice(synth: SpeechSynthesis, lang: Lang): SpeechSynthesisVoice | null {
	const cached = cachedVoices[lang];
	if (cached) return cached;
	const voices = synth.getVoices();
	if (voices.length === 0) {
		if (!voicesListenerAdded) {
			voicesListenerAdded = true;
			synth.addEventListener?.('voiceschanged', () => {
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
		voice = matches.find((v) => v.localService) ?? matches[0];
		if (voice) break;
	}
	if (!voice && lang === 'zh') voice = voices.find((v) => norm(v).startsWith('zh'));
	if (voice) cachedVoices[lang] = voice;
	return voice ?? null;
}

/** This phone's voice - one for the page's life, so an unlock from any tap
 * (the lobby, the seat circle) still counts once this phone becomes the
 * Host's and starts narrating. */
export const hostVoice = new HostVoice(browserSpeech());
