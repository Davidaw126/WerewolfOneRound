// Programmatic 8-bit sound effects via the Web Audio API — no audio assets.
// All functions are browser-only and no-op during SSR. The AudioContext is
// created lazily and resumed on the first user gesture (autoplay policy).

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

// Two independent user toggles. Deliberately NOT expressed as master.gain: the
// ambient drone routes through master too, so zeroing it to mute effects would
// silence the drone as a side effect and make the two toggles inseparable.
// One-shots mute via an early return in blip()/noise() instead, and ambient
// mutes by actually tearing down its oscillators (see syncAmbient) - which
// also stops burning CPU on a phone.
let effectsMuted = false;
let ambientEnabled = true;
/** Whether the room page currently wants a drone (i.e. is mounted). */
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
}

export function setEffectsEnabled(on: boolean): void {
	effectsMuted = !on;
	// An utterance's volume is fixed when speak() is called, so muting mid-line
	// otherwise lets it finish out loud. Cancelling is only safe once onstart
	// has already fired: JudgeAudioPlayer relays that to the server, and every
	// OTHER player's turn prompt stays hidden until it arrives - cancelling
	// first would cost the whole room the 8s reveal fallback.
	if (effectsMuted && startedFired && typeof window !== 'undefined' && window.speechSynthesis) {
		speechSynthesis.cancel();
	}
}

export function setAmbientEnabled(on: boolean): void {
	ambientEnabled = on;
	syncAmbient();
}

function blip(
	freq: number,
	dur: number,
	type: OscillatorType = 'square',
	vol = 0.5,
	slideTo?: number
): void {
	const c = ac();
	if (!c || !master || effectsMuted) return;
	const osc = c.createOscillator();
	const g = c.createGain();
	osc.type = type;
	osc.frequency.setValueAtTime(freq, c.currentTime);
	if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, c.currentTime + dur);
	g.gain.setValueAtTime(vol, c.currentTime);
	g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
	osc.connect(g);
	g.connect(master);
	osc.start();
	osc.stop(c.currentTime + dur);
}

function noise(dur: number, vol = 0.4, filterFrom = 6000, filterTo = 400): void {
	const c = ac();
	if (!c || !master || effectsMuted) return;
	const frames = Math.floor(c.sampleRate * dur);
	const buf = c.createBuffer(1, frames, c.sampleRate);
	const data = buf.getChannelData(0);
	for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
	const src = c.createBufferSource();
	src.buffer = buf;
	const filt = c.createBiquadFilter();
	filt.type = 'lowpass';
	filt.frequency.setValueAtTime(filterFrom, c.currentTime);
	filt.frequency.exponentialRampToValueAtTime(filterTo, c.currentTime + dur);
	const g = c.createGain();
	g.gain.setValueAtTime(vol, c.currentTime);
	g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
	src.connect(filt);
	filt.connect(g);
	g.connect(master);
	src.start();
	src.stop(c.currentTime + dur);
}

/** Short tactile click for button presses. */
export function sfxClick(): void {
	blip(660, 0.06, 'square', 0.3, 440);
}

/** Card-deal / phase-sweep whoosh. */
export function sfxWhoosh(): void {
	noise(0.35, 0.35, 8000, 300);
}

/** A player is eliminated — descending sting + thud. */
export function sfxDeath(): void {
	blip(320, 0.5, 'sawtooth', 0.4, 60);
	noise(0.4, 0.3, 2000, 120);
}

/** Bright confirm for game start / role reveal. */
export function sfxReveal(): void {
	blip(523, 0.08, 'square', 0.35);
	setTimeout(() => blip(784, 0.14, 'square', 0.35), 80);
}

// --- low ambient night drone ------------------------------------------------
let ambientNodes: { osc: OscillatorNode[]; lfo: OscillatorNode; gain: GainNode } | null = null;

/** The room page asks for a drone on mount and drops it on destroy; the user's
 * toggle is separate. The nodes exist only when both agree, so muting really
 * stops the oscillators rather than running them silently. */
export function startAmbient(): void {
	ambientRequested = true;
	syncAmbient();
}

export function stopAmbient(): void {
	ambientRequested = false;
	syncAmbient();
}

function syncAmbient(): void {
	if (ambientRequested && ambientEnabled) buildAmbient();
	else teardownAmbient();
}

function buildAmbient(): void {
	const c = ac();
	if (!c || !master || ambientNodes) return;
	const gain = c.createGain();
	gain.gain.value = 0.05;
	const o1 = c.createOscillator();
	o1.type = 'sine';
	o1.frequency.value = 55;
	const o2 = c.createOscillator();
	o2.type = 'triangle';
	o2.frequency.value = 82.5;
	const lfo = c.createOscillator();
	lfo.frequency.value = 0.12;
	const lfoGain = c.createGain();
	lfoGain.gain.value = 0.025;
	lfo.connect(lfoGain);
	lfoGain.connect(gain.gain);
	o1.connect(gain);
	o2.connect(gain);
	gain.connect(master);
	o1.start();
	o2.start();
	lfo.start();
	ambientNodes = { osc: [o1, o2], lfo, gain };
}

function teardownAmbient(): void {
	if (!ambientNodes) return;
	try {
		ambientNodes.osc.forEach((o) => o.stop());
		ambientNodes.lfo.stop();
		ambientNodes.gain.disconnect();
	} catch {
		/* already stopped */
	}
	ambientNodes = null;
}

// --- narration via the Web Speech API ---------------------------------------
// Browser text-to-speech, not a media file - lets narration cover any event
// (not just a fixed set of recorded clips) and gives independent pitch/rate
// knobs on the utterance itself (unlike HTMLMediaElement.playbackRate, which
// ties the two together). Voice character/quality depends on what the
// browser/OS provides - there is no way to route it through the Web Audio
// effects used elsewhere in this file, since browsers don't expose
// speechSynthesis output as a capturable audio stream.

let cachedVoice: SpeechSynthesisVoice | null | undefined;

function pickChineseVoice(): SpeechSynthesisVoice | null {
	if (typeof window === 'undefined' || !window.speechSynthesis) return null;
	if (cachedVoice !== undefined) return cachedVoice;

	const voices = speechSynthesis.getVoices();
	if (voices.length === 0) {
		// Voice list loads asynchronously in most browsers - retry once it's ready.
		speechSynthesis.addEventListener(
			'voiceschanged',
			() => {
				cachedVoice = undefined;
				pickChineseVoice();
			},
			{ once: true }
		);
		return null;
	}
	cachedVoice = voices.find((v) => v.lang.toLowerCase().startsWith('zh')) ?? null;
	return cachedVoice;
}

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
	onStart?: () => void;
}

const narrationQueue: NarrationItem[] = [];
let speaking = false;
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
function finishCurrent(): void {
	if (stuckTimer) {
		clearTimeout(stuckTimer);
		stuckTimer = null;
	}
	speaking = false;
	startedFired = false;
	setTimeout(speakNext, NARRATION_GAP_MS);
}

function speakNext(): void {
	if (speaking) return;
	const item = narrationQueue.shift();
	if (item === undefined) return;
	speaking = true;
	startedFired = false;

	const utter = new SpeechSynthesisUtterance(item.text);
	const voice = pickChineseVoice();
	if (voice) utter.voice = voice;
	utter.lang = voice?.lang ?? 'zh-CN';
	utter.pitch = 0.6; // deeper, independent of rate
	utter.rate = 0.8;
	// Muting is volume-only, never an early return: the utterance must still
	// run so onstart still fires, because the rest of the room's turn prompts
	// are gated on the signal it relays.
	utter.volume = effectsMuted ? 0 : 1;
	utter.onstart = () => {
		startedFired = true;
		item.onStart?.();
	};
	utter.onend = utter.onerror = finishCurrent;
	speechSynthesis.speak(utter);

	// Many mobile browsers silently kill speech synthesis when the tab/app is
	// backgrounded, WITHOUT ever firing onend/onerror - pause()/resume() and
	// narrationWatchdog() below both rely on the engine honestly reporting its
	// own state, which is exactly what doesn't happen in that failure mode.
	// This timer doesn't trust the engine's state at all: if an utterance has
	// been "in flight" unreasonably long, force the queue to move on
	// regardless of what speechSynthesis claims.
	stuckTimer = setTimeout(() => {
		if (speaking) finishCurrent();
	}, MAX_UTTERANCE_MS);
}

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
		if (stuckTimer) {
			clearTimeout(stuckTimer);
			stuckTimer = null;
		}
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
export function narrate(text: string, onStart?: () => void): void {
	if (typeof window === 'undefined' || !window.speechSynthesis) {
		onStart?.();
		return;
	}
	narrationQueue.push({ text, onStart });
	speakNext();
}

/** Cuts off whatever narration is currently queued/speaking, if any. */
export function stopNarration(): void {
	if (typeof window === 'undefined' || !window.speechSynthesis) return;
	if (stuckTimer) {
		clearTimeout(stuckTimer);
		stuckTimer = null;
	}
	narrationQueue.length = 0;
	speaking = false;
	speechSynthesis.cancel();
}
