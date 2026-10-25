// Night ambience (a stormy forest, synthesised with the Web Audio API - no
// audio assets) plus the host phone's spoken narration further down. There
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
		// iPhone: the system voice (speechSynthesis) can take over the audio
		// session and knock this context into 'interrupted'/'suspended' while
		// it speaks - and it doesn't always come back by itself, so the night
		// ambience would just stop after the first announcement. Bring it
		// back as soon as the browser lets us.
		const c = ctx;
		c.onstatechange = () => {
			if (c.state !== 'running' && ambientRequested) setTimeout(resumeAudio, 400);
		};
		master = ctx.createGain();
		master.gain.value = 0.35;
		master.connect(ctx.destination);
	}
	return ctx;
}

/** Resume after an interruption (see ac()) - no gesture needed for that. */
function resumeAudio(): void {
	if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') {
		void ctx.resume().then(syncAmbient, () => {});
	}
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

// --- night ambience: a forest at night, weather rolling through ---------------
// Layers, all synthesised (no audio files):
//  - wind that gusts and falls away (never a steady hum: it's band-passed
//    noise whose level and colour keep moving), with the trees' leaves
//    rustling harder on every gust;
//  - grass swishing nearby now and then;
//  - crickets (fewer when it pours), an owl, and wolves - a lone howl or a
//    small pack answering each other;
//  - weather on a cycle: clear -> drizzle -> rain -> thunderstorm -> rain ->
//    clear. Rain is drops on leaves only (a continuous hiss read as static),
//    with near cracks and far rumbles of thunder.
// Everything ducks under the judge's voice while a line is spoken.

type Weather = 'clear' | 'drizzle' | 'rain' | 'storm';

interface Ambience {
	bus: GainNode;
	duck: GainNode;
	timers: ReturnType<typeof setTimeout>[];
	sources: AudioScheduledSourceNode[];
	weather: Weather;
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

/** Lower the forest while the judge speaks, so every line stays clear. */
function duckAmbience(on: boolean): void {
	const c = ctx;
	if (!c || !ambience) return;
	ambience.duck.gain.setTargetAtTime(on ? 0.35 : 1, c.currentTime, on ? 0.15 : 0.6);
}

/** A soft outdoor echo: a stereo impulse response of fading noise. */
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

const rand = (min: number, max: number) => min + Math.random() * (max - min);

function buildAmbience(): void {
	const c = ac();
	if (!c || !master || ambience || c.state !== 'running') return;

	const duck = c.createGain();
	duck.connect(master);
	const bus = c.createGain();
	bus.gain.setValueAtTime(0.0001, c.currentTime);
	bus.gain.exponentialRampToValueAtTime(0.9, c.currentTime + 4); // fade in
	bus.connect(duck);
	const reverb = makeReverb(c, 3);
	const wet = c.createGain();
	wet.gain.value = 0.55;
	reverb.connect(wet);
	wet.connect(bus);

	const a: Ambience = {
		bus,
		duck,
		timers: [],
		sources: [],
		weather: Math.random() < 0.35 ? 'rain' : 'clear'
	};
	ambience = a;
	const later = (ms: number, fn: () => void) => {
		a.timers.push(setTimeout(() => ambience === a && fn(), ms));
	};
	const now = () => c.currentTime;

	// Shared noise: 6 s of white noise, every noisy layer reads its own
	// offset of it, so they don't sound like copies of each other.
	const NOISE_S = 6;
	const noise = c.createBuffer(1, c.sampleRate * NOISE_S, c.sampleRate);
	{
		const d = noise.getChannelData(0);
		for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
	}
	const loopNoise = (): AudioBufferSourceNode => {
		const src = c.createBufferSource();
		src.buffer = noise;
		src.loop = true;
		src.start(0, rand(0, NOISE_S));
		a.sources.push(src);
		return src;
	};
	const oneShotNoise = (dur: number): AudioBufferSourceNode => {
		const src = c.createBufferSource();
		src.buffer = noise;
		src.start(now(), rand(0, NOISE_S - dur - 0.1), dur);
		return src;
	};
	/** node -> panner -> dry bus + echo send. */
	const out = (node: AudioNode, pan: number, dry = 1, send = 1) => {
		const p = c.createStereoPanner();
		p.pan.value = pan;
		node.connect(p);
		const d = c.createGain();
		d.gain.value = dry;
		p.connect(d);
		d.connect(bus);
		if (send > 0) {
			const sg = c.createGain();
			sg.gain.value = send;
			p.connect(sg);
			sg.connect(reverb);
		}
	};
	const filter = (type: BiquadFilterType, freq: number, q = 0.7) => {
		const f = c.createBiquadFilter();
		f.type = type;
		f.frequency.value = freq;
		f.Q.value = q;
		return f;
	};
	const stormy = () =>
		a.weather === 'storm' ? 1 : a.weather === 'rain' ? 0.6 : a.weather === 'drizzle' ? 0.3 : 0;

	// ---- wind + leaves (two gusting streams, left and right) ----------------
	const leaves = c.createGain();
	leaves.gain.value = 0.0001;
	{
		const src = loopNoise();
		const hp = filter('highpass', 1800);
		const bp = filter('bandpass', 3800, 0.5);
		src.connect(hp);
		hp.connect(bp);
		bp.connect(leaves);
		out(leaves, 0, 0.9, 0.4);
	}
	for (const pan of [-0.6, 0.6]) {
		const src = loopNoise();
		const hp = filter('highpass', 160); // nothing low enough to hum
		const bp = filter('bandpass', 500, 0.8);
		const g = c.createGain();
		g.gain.value = 0.0001;
		src.connect(hp);
		hp.connect(bp);
		bp.connect(g);
		out(g, pan, 1, 0.5);
		const gust = () => {
			const strength = Math.min(1, rand(0.15, 0.7) + stormy() * 0.4);
			const t = now();
			g.gain.setTargetAtTime(0.02 + strength * 0.22, t, rand(0.6, 1.6));
			bp.frequency.setTargetAtTime(280 + strength * 1100, t, rand(0.8, 1.8));
			leaves.gain.setTargetAtTime(0.004 + strength * strength * 0.09, t, 0.7);
			// ...and let it die back down before the next one.
			later(rand(1500, 3500), () => {
				g.gain.setTargetAtTime(0.015 + stormy() * 0.05, now(), rand(1.2, 2.5));
				leaves.gain.setTargetAtTime(0.003 + stormy() * 0.02, now(), 1.2);
			});
			later(rand(2500, 6000) * (1 - stormy() * 0.4), gust);
		};
		later(rand(200, 2500), gust);
	}

	// ---- grass swishing nearby -----------------------------------------------
	const swish = () => {
		const dur = rand(0.35, 0.8);
		const src = oneShotNoise(dur);
		const hp = filter('highpass', rand(3000, 5000));
		const g = c.createGain();
		const t = now();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.exponentialRampToValueAtTime(rand(0.02, 0.05), t + dur * 0.35);
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		src.connect(hp);
		hp.connect(g);
		out(g, rand(-0.9, 0.9), 1, 0.2);
		if (Math.random() < 0.4)
			later(rand(250, 600), swish); // a step or two
		else later(rand(2500, 7000), swish);
	};
	later(rand(1500, 4000), swish);

	// ---- crickets -------------------------------------------------------------
	const cricket = (pitch: number, pan: number) => {
		const chirp = () => {
			if (Math.random() > stormy() * 0.8) {
				const t0 = now();
				const pulses = 2 + Math.floor(Math.random() * 3);
				for (let k = 0; k < pulses; k++) {
					const at = t0 + k * 0.065;
					const osc = c.createOscillator();
					osc.frequency.value = pitch;
					const g = c.createGain();
					g.gain.setValueAtTime(0.0001, at);
					g.gain.exponentialRampToValueAtTime(0.012, at + 0.01);
					g.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
					osc.connect(g);
					out(g, pan, 1, 0.3);
					osc.start(at);
					osc.stop(at + 0.05);
				}
			}
			later(rand(300, 900), chirp);
		};
		later(rand(300, 2000), chirp);
	};
	cricket(rand(4200, 4500), rand(-0.8, -0.3));
	cricket(rand(4600, 5000), rand(0.3, 0.8));
	cricket(rand(3900, 4200), rand(-0.2, 0.2));

	// ---- owl --------------------------------------------------------------------
	const owl = () => {
		const pan = rand(-0.8, 0.8);
		const hoot = (at: number, f: number, dur: number) => {
			const osc = c.createOscillator();
			osc.frequency.setValueAtTime(f, at);
			osc.frequency.exponentialRampToValueAtTime(f * 0.88, at + dur);
			const g = c.createGain();
			g.gain.setValueAtTime(0.0001, at);
			g.gain.exponentialRampToValueAtTime(0.05, at + 0.06);
			g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
			osc.connect(g);
			out(g, pan, 0.6, 0.8);
			osc.start(at);
			osc.stop(at + dur + 0.05);
		};
		const t0 = now();
		const f = rand(360, 420);
		hoot(t0, f, 0.5); // hoo...
		hoot(t0 + 0.9, f * 1.05, 0.25); // hoo-
		hoot(t0 + 1.2, f * 1.05, 0.25); // hoo-
		hoot(t0 + 1.5, f, 0.6); // hooo
		later(rand(12_000, 25_000), owl);
	};
	later(rand(4000, 9000), owl);

	// ---- wolves -----------------------------------------------------------------
	const howl = (delay: number, base: number, pan: number, far: number) => {
		const t0 = now() + delay;
		const peak = base * rand(1.6, 1.9);
		const len = rand(3, 4.6);
		const voice = c.createGain();
		// Two pure sines (fundamental + a quiet octave) - a voice, not a buzz.
		for (const [mult, lvl] of [
			[1, 1],
			[2, 0.12]
		] as const) {
			const osc = c.createOscillator();
			osc.frequency.setValueAtTime(base * mult, t0);
			osc.frequency.exponentialRampToValueAtTime(peak * mult, t0 + len * 0.3);
			osc.frequency.setValueAtTime(peak * mult, t0 + len * 0.6);
			osc.frequency.exponentialRampToValueAtTime(base * 1.1 * mult, t0 + len);
			const vib = c.createOscillator();
			vib.frequency.value = rand(4.5, 6);
			const vibAmt = c.createGain();
			vibAmt.gain.value = 5 * mult;
			vib.connect(vibAmt);
			vibAmt.connect(osc.frequency);
			const lg = c.createGain();
			lg.gain.value = lvl;
			osc.connect(lg);
			lg.connect(voice);
			osc.start(t0);
			vib.start(t0);
			osc.stop(t0 + len + 0.1);
			vib.stop(t0 + len + 0.1);
		}
		const g = c.createGain();
		const peakGain = 0.07 * (1 - far * 0.6);
		g.gain.setValueAtTime(0.0001, t0);
		g.gain.exponentialRampToValueAtTime(peakGain, t0 + len * 0.25);
		g.gain.setValueAtTime(peakGain, t0 + len * 0.65);
		g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
		const lp = filter('lowpass', 1400 - far * 600);
		voice.connect(lp);
		lp.connect(g);
		out(g, pan, 1 - far * 0.6, 0.6 + far * 0.6);
	};
	const wolves = () => {
		const far = rand(0.2, 0.9);
		howl(0, rand(250, 310), rand(-0.8, 0.8), far);
		// Often the pack answers.
		if (Math.random() < 0.55) {
			const answers = 1 + Math.floor(Math.random() * 3);
			for (let k = 0; k < answers; k++) {
				howl(
					rand(0.6, 2.8) + k * 0.8,
					rand(230, 360),
					rand(-0.9, 0.9),
					Math.min(1, far + rand(-0.2, 0.3))
				);
			}
		}
		later(rand(10_000, 22_000), wolves);
	};
	later(rand(3000, 7000), wolves);

	// ---- rain: only drops on leaves - no continuous hiss --------------------------
	// A loop of sparse random ticks, so it reads as drops, never as static.
	const patterGain = c.createGain();
	patterGain.gain.value = 0.0001;
	{
		const len = c.sampleRate * 3;
		const buf = c.createBuffer(2, len, c.sampleRate);
		for (let ch = 0; ch < 2; ch++) {
			const d = buf.getChannelData(ch);
			for (let n = 0; n < 110; n++) {
				const at = Math.floor(Math.random() * (len - 400));
				const amp = rand(0.2, 1);
				for (let k = 0; k < 300; k++)
					d[at + k] += (Math.random() * 2 - 1) * amp * Math.exp(-k / 40);
			}
		}
		const src = c.createBufferSource();
		src.buffer = buf;
		src.loop = true;
		src.start();
		a.sources.push(src);
		const bp = filter('bandpass', 2600, 0.6);
		src.connect(bp);
		bp.connect(patterGain);
		patterGain.connect(bus);
	}

	// ---- thunder --------------------------------------------------------------------
	const thunder = (near: boolean) => {
		const t0 = now() + (near ? 0 : rand(0, 0.5));
		if (near) {
			// The crack.
			const crack = oneShotNoise(0.6);
			const hp = filter('highpass', 1400);
			const g = c.createGain();
			g.gain.setValueAtTime(0.0001, t0);
			g.gain.exponentialRampToValueAtTime(0.28, t0 + 0.01);
			g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
			crack.connect(hp);
			hp.connect(g);
			out(g, rand(-0.5, 0.5), 1, 0.9);
		}
		// The rumble - kept above ~150 Hz so a phone speaker can play it.
		const dur = rand(4, 7);
		const src = oneShotNoise(dur);
		const lp = filter('lowpass', near ? 380 : 240, 0.9);
		const hp = filter('highpass', 120);
		const g = c.createGain();
		const peak = near ? rand(0.35, 0.5) : rand(0.12, 0.22);
		g.gain.setValueAtTime(0.0001, t0);
		g.gain.exponentialRampToValueAtTime(peak, t0 + (near ? 0.25 : 0.8));
		// Rolling: a few swells on the way down.
		let t = t0 + 0.8;
		while (t < t0 + dur - 1) {
			g.gain.exponentialRampToValueAtTime(peak * rand(0.3, 0.9), t);
			t += rand(0.4, 1.1);
		}
		g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
		src.connect(hp);
		hp.connect(lp);
		lp.connect(g);
		out(g, rand(-0.6, 0.6), 1, 0.8);
	};
	const thunderLoop = () => {
		if (a.weather === 'storm') thunder(Math.random() < 0.5);
		else if (a.weather === 'rain' && Math.random() < 0.3) thunder(false);
		later(a.weather === 'storm' ? rand(5000, 12_000) : rand(12_000, 25_000), thunderLoop);
	};
	later(rand(5000, 10_000), thunderLoop);

	// ---- the weather cycle ---------------------------------------------------------
	const LEVELS: Record<Weather, { patter: number }> = {
		clear: { patter: 0.0001 },
		drizzle: { patter: 0.04 },
		rain: { patter: 0.08 },
		storm: { patter: 0.12 }
	};
	const NEXT: Record<Weather, Weather[]> = {
		clear: ['drizzle'],
		drizzle: ['rain', 'clear'],
		rain: ['storm', 'storm', 'drizzle'],
		storm: ['rain']
	};
	const LASTS: Record<Weather, [number, number]> = {
		clear: [25_000, 50_000],
		drizzle: [15_000, 30_000],
		rain: [25_000, 45_000],
		storm: [30_000, 55_000]
	};
	const setWeather = (w: Weather) => {
		a.weather = w;
		const t = now();
		patterGain.gain.setTargetAtTime(LEVELS[w].patter, t, 4);
		if (w === 'storm') later(rand(1500, 4000), () => thunder(true)); // announce it
		const [lo, hi] = LASTS[w];
		later(rand(lo, hi), () => {
			const options = NEXT[w];
			setWeather(options[Math.floor(Math.random() * options.length)]);
		});
	};
	setWeather(a.weather);
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
			a.bus.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 2); // fade out
		}
		setTimeout(() => {
			for (const src of a.sources) {
				try {
					src.stop();
				} catch {
					/* already stopped */
				}
			}
			a.duck.disconnect();
		}, 4500);
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
		duckAmbience(true);
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
		duckAmbience(false);
		resumeAudio(); // in case the voice interrupted the ambience (iPhone)
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
