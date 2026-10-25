// Night ambience (water droplets and a distant wolf, synthesised with the Web
// Audio API - no audio assets) plus the host phone's spoken narration further down. There
// are no other sound effects: button clicks, whooshes and stings were
// removed so the only sounds at the table are the judge's voice and, during
// the night, the ambience. All browser-only; no-ops during SSR. The
// AudioContext is created lazily and resumed on the first user gesture
// (autoplay policy).

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

// Two independent user toggles: the ambience is mood you may want gone while
// keeping the judge's voice, and the voice is the app actively telling you
// things. The ambience mutes by actually tearing down its nodes (see
// syncAmbient), which also stops burning CPU on a phone.
let voiceMuted = false;
let ambientEnabled = true;
/** Whether it's currently night on the judge's phone (JudgeAudioPlayer). */
let ambientRequested = false;

function ac(): AudioContext | null {
	if (typeof window === 'undefined') return null;
	if (!ctx) {
		const Ctor =
			window.AudioContext ||
			(window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
		if (!Ctor) return null;
		ctx = new Ctor();
		master = ctx.createGain();
		master.gain.value = 0.35;
		master.connect(ctx.destination);
	}
	return ctx;
}

/** Resume the context after a user gesture. Safe to call repeatedly.
 * Can't fight a mute: muting is never expressed as context state, so resuming
 * the clock for a muted user produces exactly zero sound. */
export function unlockAudio(): void {
	const c = ac();
	if (c && c.state === 'suspended') void c.resume();
	// The ambience may have been asked for before the first tap made audio
	// possible - build it now that it can actually play.
	syncAmbient();
}

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

export function setAmbientEnabled(on: boolean): void {
	ambientEnabled = on;
	syncAmbient();
}

// --- night ambience -----------------------------------------------------------
// Relaxing and sparse: water droplets falling in a softly echoing space, and
// once in a while a distant wolf howl. Nothing continuous - no wind, no drone
// - so there's no background buzz under the judge's voice.

interface Ambience {
	bus: GainNode;
	timers: ReturnType<typeof setTimeout>[];
}
let ambience: Ambience | null = null;

/** Night falls: the judge's phone starts the ambience. */
export function startAmbient(): void {
	ambientRequested = true;
	syncAmbient();
}

/** Day breaks (or the room is left): the ambience stops. */
export function stopAmbient(): void {
	ambientRequested = false;
	syncAmbient();
}

function syncAmbient(): void {
	if (ambientRequested && ambientEnabled) buildAmbience();
	else teardownAmbience();
}

/** A soft room/cave echo: a stereo impulse response of fading noise. */
function makeReverb(c: AudioContext, seconds: number): ConvolverNode {
	const len = Math.floor(c.sampleRate * seconds);
	const ir = c.createBuffer(2, len, c.sampleRate);
	for (let ch = 0; ch < 2; ch++) {
		const d = ir.getChannelData(ch);
		for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
	}
	const conv = c.createConvolver();
	conv.buffer = ir;
	return conv;
}

function buildAmbience(): void {
	const c = ac();
	if (!c || !master || ambience || c.state !== 'running') return;

	const bus = c.createGain();
	bus.gain.setValueAtTime(0.0001, c.currentTime);
	bus.gain.exponentialRampToValueAtTime(1, c.currentTime + 3); // fade in
	bus.connect(master);
	// Dry + echo: the echo is what makes single plinks sound like a cave.
	const reverb = makeReverb(c, 2.8);
	const wet = c.createGain();
	wet.gain.value = 0.6;
	reverb.connect(wet);
	wet.connect(bus);

	const a: Ambience = { bus, timers: [] };
	ambience = a;
	const later = (ms: number, fn: () => void) => {
		a.timers.push(setTimeout(() => ambience === a && fn(), ms));
	};
	const out = (node: AudioNode, pan: number, dry: number) => {
		const p = c.createStereoPanner();
		p.pan.value = pan;
		const g = c.createGain();
		g.gain.value = dry;
		node.connect(p);
		p.connect(g);
		g.connect(bus);
		p.connect(reverb);
	};

	// One droplet: a short sine whose pitch flicks upward - the "plip".
	const droplet = (at: number) => {
		const base = 700 + Math.random() * 900;
		const osc = c.createOscillator();
		osc.type = 'sine';
		osc.frequency.setValueAtTime(base, at);
		osc.frequency.exponentialRampToValueAtTime(base * (1.5 + Math.random() * 0.4), at + 0.05);
		const g = c.createGain();
		g.gain.setValueAtTime(0.0001, at);
		g.gain.exponentialRampToValueAtTime(0.07 + Math.random() * 0.05, at + 0.006);
		g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
		osc.connect(g);
		out(g, Math.random() * 1.4 - 0.7, 0.5);
		osc.start(at);
		osc.stop(at + 0.25);
	};
	const drip = () => {
		const t0 = c.currentTime;
		droplet(t0);
		// Now and then two or three in a row, like a leak gathering pace.
		if (Math.random() < 0.25) droplet(t0 + 0.18 + Math.random() * 0.2);
		if (Math.random() < 0.08) droplet(t0 + 0.5 + Math.random() * 0.3);
		later(700 + Math.random() * 2600, drip);
	};

	// A distant wolf: a soft tone rising, holding with a slight waver,
	// then sinking - mostly heard through the echo, so it sits far away.
	const howl = () => {
		const t0 = c.currentTime;
		const start = 260 + Math.random() * 60;
		const peak = start * (1.7 + Math.random() * 0.2);
		// Pure sine: anything with harmonics (triangle/square) reads as a
		// retro buzz rather than a far-off wolf.
		const osc = c.createOscillator();
		osc.type = 'sine';
		osc.frequency.setValueAtTime(start, t0);
		osc.frequency.exponentialRampToValueAtTime(peak, t0 + 1.0);
		osc.frequency.setValueAtTime(peak, t0 + 1.9);
		osc.frequency.exponentialRampToValueAtTime(start * 1.15, t0 + 3.4);
		const vib = c.createOscillator();
		vib.frequency.value = 5;
		const vibAmt = c.createGain();
		vibAmt.gain.value = 6;
		vib.connect(vibAmt);
		vibAmt.connect(osc.frequency);
		const lp = c.createBiquadFilter();
		lp.type = 'lowpass';
		lp.frequency.value = 1100;
		const g = c.createGain();
		g.gain.setValueAtTime(0.0001, t0);
		g.gain.exponentialRampToValueAtTime(0.045, t0 + 0.7);
		g.gain.setValueAtTime(0.045, t0 + 2.2);
		g.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.5);
		osc.connect(lp);
		lp.connect(g);
		out(g, Math.random() * 1.2 - 0.6, 0.25);
		osc.start(t0);
		vib.start(t0);
		osc.stop(t0 + 3.6);
		vib.stop(t0 + 3.6);
		later(60_000 + Math.random() * 60_000, howl); // rare: once every 1-2 minutes
	};

	later(600, drip);
	later(20_000 + Math.random() * 20_000, howl);
}

function teardownAmbience(): void {
	if (!ambience) return;
	const a = ambience;
	ambience = null;
	a.timers.forEach(clearTimeout);
	const c = ctx;
	try {
		if (c) {
			a.bus.gain.cancelScheduledValues(c.currentTime);
			a.bus.gain.setValueAtTime(Math.max(a.bus.gain.value, 0.0001), c.currentTime);
			a.bus.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 1.5); // fade out
		}
		// Every source is a one-shot that stops itself; just unhook the bus
		// once the fade (and the last echo tail) is done.
		setTimeout(() => a.bus.disconnect(), 4500);
	} catch {
		/* context gone */
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
	// iOS 17+: put the page's audio session in "playback" so Web Audio isn't
	// silenced by the ring/silent switch.
	const nav = navigator as Navigator & { audioSession?: { type: string } };
	if (nav.audioSession) {
		try {
			nav.audioSession.type = 'playback';
		} catch {
			/* older engines throw on unknown values */
		}
	}
	if (speechPrimed) return;
	speechPrimed = true;
	const u = new SpeechSynthesisUtterance('.');
	u.volume = 0;
	u.rate = 2;
	keepAlive.add(u);
	u.onend = u.onerror = () => keepAlive.delete(u);
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
