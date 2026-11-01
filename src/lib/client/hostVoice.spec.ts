// The Host's voice through a fake speech engine and fake timers: the iPhone
// failure modes (a refused line, a lost onend, a paused engine, no unlock)
// played out without a phone.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	HostVoice,
	GAP_MS,
	START_GRACE_MS,
	BLOCKED_AFTER_MS,
	MAX_LINE_MS,
	type SpeechEngine,
	type UtteranceEvents
} from './hostVoice';

type Spoken = { text: string; volume: number; events: UtteranceEvents };

class FakeEngine implements SpeechEngine {
	supported = true;
	busy = false;
	spoken: Spoken[] = [];
	cancels = 0;
	speak(text: string, opts: { volume: number }, events: UtteranceEvents) {
		this.spoken.push({ text, volume: opts.volume, events });
	}
	cancel() {
		this.cancels++;
	}
	resume() {}
	usePlaybackSession() {}
	/** The lines actually spoken, without the silent unlock ('.'). */
	get lines() {
		return this.spoken.filter((s) => s.text !== '.').map((s) => s.text);
	}
	last() {
		return this.spoken[this.spoken.length - 1];
	}
}

let engine: FakeEngine;
let voice: HostVoice;
let blocked: number;

/** A tap that unlocks speech on this phone. */
function tapUnlocks() {
	voice.prime();
	engine.last().events.onstart();
	engine.last().events.onend();
}

beforeEach(() => {
	vi.useFakeTimers();
	engine = new FakeEngine();
	voice = new HostVoice(engine);
	blocked = 0;
	voice.onBlocked(() => blocked++);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('unlocking', () => {
	it('before any tap, a line is not spoken, its start goes out at once, and the Host is told once', () => {
		const started = vi.fn();
		voice.say({ text: 'night falls', lang: 'en', onStart: started });
		voice.say({ text: 'wolves', lang: 'en' });
		expect(engine.lines).toEqual([]);
		expect(started).toHaveBeenCalledTimes(1);
		expect(blocked).toBe(1);
	});

	it('a tap anywhere unlocks it - one flag, kept for the page’s life', () => {
		expect(voice.unlock).toBe('locked');
		tapUnlocks();
		expect(voice.unlock).toBe('unlocked');
		voice.say({ text: 'night falls', lang: 'en' });
		expect(engine.lines).toEqual(['night falls']);
	});

	it('a tap that iOS refused silently is retried by the next tap', () => {
		voice.prime();
		voice.prime();
		expect(engine.spoken.length).toBe(1);
		vi.advanceTimersByTime(1500);
		voice.prime();
		expect(engine.spoken.length).toBe(2);
	});

	it('no speech at all (an in-app browser): every start goes out at once', () => {
		engine.supported = false;
		const started = vi.fn();
		voice.say({ text: 'x', lang: 'en', onStart: started });
		expect(started).toHaveBeenCalled();
		expect(engine.spoken).toEqual([]);
	});
});

describe('the queue', () => {
	beforeEach(tapUnlocks);

	it('a line’s start goes out when it really starts, once', () => {
		const started = vi.fn();
		voice.say({ text: 'wolves', lang: 'en', onStart: started });
		expect(started).not.toHaveBeenCalled();
		engine.last().events.onstart();
		vi.advanceTimersByTime(START_GRACE_MS);
		expect(started).toHaveBeenCalledTimes(1);
	});

	it('waits for a line to end, then pauses, before the next', () => {
		voice.say({ text: 'night falls', lang: 'en' });
		voice.say({ text: 'wolves', lang: 'en' });
		engine.last().events.onstart();
		engine.last().events.onend();
		vi.advanceTimersByTime(GAP_MS - 1);
		expect(engine.lines).toEqual(['night falls']);
		vi.advanceTimersByTime(1);
		expect(engine.lines).toEqual(['night falls', 'wolves']);
	});

	it('a turn’s call-out still queued when the turn ends is dropped', () => {
		voice.say({ text: 'night falls', lang: 'en' });
		voice.say({ text: 'seer', lang: 'en', tag: 'stage' });
		voice.drop('stage');
		engine.last().events.onend();
		vi.advanceTimersByTime(GAP_MS);
		expect(engine.lines).toEqual(['night falls']);
	});

	it('stopping cuts everything; the next line waits a beat after the cancel', () => {
		voice.say({ text: 'a', lang: 'en' });
		voice.say({ text: 'b', lang: 'en' });
		voice.stop();
		expect(engine.cancels).toBe(1);
		voice.say({ text: 'c', lang: 'en' });
		expect(engine.lines).toEqual(['a']);
		vi.advanceTimersByTime(250);
		expect(engine.lines).toEqual(['a', 'c']);
	});
});

describe('when the phone stops speaking', () => {
	beforeEach(tapUnlocks);

	it('a refused line: its start goes out after the grace, then the Host is asked to tap', () => {
		const started = vi.fn();
		voice.say({ text: 'wolves', lang: 'en', onStart: started });
		voice.say({ text: 'seer', lang: 'en' });
		vi.advanceTimersByTime(START_GRACE_MS);
		expect(started).toHaveBeenCalledTimes(1);
		expect(blocked).toBe(0);
		vi.advanceTimersByTime(BLOCKED_AFTER_MS - START_GRACE_MS);
		expect(blocked).toBe(1);
		expect(engine.cancels).toBe(1);
		// The unlock is forgotten, so the next tap tries again.
		expect(voice.unlock).toBe('tried');
		vi.advanceTimersByTime(GAP_MS);
		expect(engine.lines).toEqual(['wolves', 'seer']);
	});

	it('a line whose end never comes (backgrounded) is given up on', () => {
		voice.say({ text: 'a', lang: 'en' });
		voice.say({ text: 'b', lang: 'en' });
		engine.last().events.onstart();
		vi.advanceTimersByTime(MAX_LINE_MS + GAP_MS);
		expect(engine.lines).toEqual(['a', 'b']);
	});

	it('back in the foreground, a line the engine dropped silently is let go at once', () => {
		const started = vi.fn();
		voice.say({ text: 'a', lang: 'en', onStart: started });
		voice.say({ text: 'b', lang: 'en' });
		engine.busy = false;
		voice.wake();
		expect(started).toHaveBeenCalled();
		expect(engine.lines).toEqual(['a', 'b']);
	});

	it('a stale end from a line already given up on doesn’t end the next one', () => {
		voice.say({ text: 'a', lang: 'en' });
		const first = engine.last();
		voice.say({ text: 'b', lang: 'en' });
		engine.busy = false;
		voice.wake();
		voice.say({ text: 'c', lang: 'en' });
		first.events.onend();
		vi.advanceTimersByTime(GAP_MS);
		expect(engine.lines).toEqual(['a', 'b']);
	});
});

describe('muting', () => {
	beforeEach(tapUnlocks);

	it('a muted line still runs, silently, so its start still goes out', () => {
		voice.setMuted(true);
		const started = vi.fn();
		voice.say({ text: 'wolves', lang: 'en', onStart: started });
		expect(engine.last().volume).toBe(0);
		engine.last().events.onstart();
		expect(started).toHaveBeenCalled();
		vi.advanceTimersByTime(BLOCKED_AFTER_MS);
		expect(blocked).toBe(0);
	});

	it('muting mid-line cuts it only once its start has gone out', () => {
		voice.say({ text: 'wolves', lang: 'en' });
		voice.setMuted(true);
		expect(engine.cancels).toBe(0);
		voice.setMuted(false);
		engine.last().events.onstart();
		voice.setMuted(true);
		expect(engine.cancels).toBe(1);
	});
});

describe('a line whose end never arrives', () => {
	it('the queue moves on once the engine has gone quiet, not after MAX_LINE_MS', () => {
		tapUnlocks();
		voice.say({ text: 'night falls', lang: 'zh' });
		voice.say({ text: 'wolves wake', lang: 'zh' });
		vi.advanceTimersByTime(300);
		engine.busy = true;
		engine.last().events.onstart();
		vi.advanceTimersByTime(2000);
		expect(engine.lines).toEqual(['night falls']);
		// Finished speaking, and iOS lost the onend.
		engine.busy = false;
		vi.advanceTimersByTime(1000 + GAP_MS);
		expect(engine.lines).toEqual(['night falls', 'wolves wake']);
	});

	it('an engine that never reported busy still waits for the line’s real end', () => {
		tapUnlocks();
		voice.say({ text: 'night falls', lang: 'zh' });
		voice.say({ text: 'wolves wake', lang: 'zh' });
		vi.advanceTimersByTime(300);
		engine.last().events.onstart();
		vi.advanceTimersByTime(5000);
		expect(engine.lines).toEqual(['night falls']);
	});
});
