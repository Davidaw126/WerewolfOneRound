// The user's two audio preferences, persisted per device. Mirrors the
// confirmDialog store's shape: a rune-backed class, one singleton, and thin
// function wrappers, initialised once from the root layout.
//
// Kept split into two toggles because they answer different questions: the
// ambient drone is background mood you may want gone while keeping the game
// audible, whereas effects/narration are the app actively telling you things.

import { setAmbientEnabled, setEffectsEnabled } from './sfx';

const LS_AMBIENT = 'wolf.audio.ambient';
const LS_EFFECTS = 'wolf.audio.effects';

/** localStorage throws in Safari private mode, and doesn't exist during SSR -
 * a lost preference is never worth breaking the page over. */
function readStored(key: string): boolean | null {
	if (typeof window === 'undefined') return null;
	try {
		const raw = window.localStorage.getItem(key);
		if (raw === '1') return true;
		if (raw === '0') return false;
		return null;
	} catch {
		return null;
	}
}

function persist(key: string, value: boolean): void {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(key, value ? '1' : '0');
	} catch {
		/* private mode / quota - preference just won't survive the reload */
	}
}

class AudioSettings {
	/** The looping ambient night drone. */
	ambient = $state(true);
	/** One-shot sound effects, and (on the host's device) spoken narration. */
	effects = $state(true);

	/**
	 * Loads stored preferences and pushes them into sfx.ts. Must be called from
	 * onMount rather than the constructor - this module is imported during SSR,
	 * where the singleton is constructed but localStorage doesn't exist.
	 *
	 * Both default to on, so the pre-hydration render matches the app's
	 * long-standing behaviour; a muted user sees the icon flip once on hydrate,
	 * which is unavoidable without moving the preference to a cookie.
	 */
	init(): void {
		const ambient = readStored(LS_AMBIENT);
		const effects = readStored(LS_EFFECTS);
		if (ambient !== null) this.ambient = ambient;
		if (effects !== null) this.effects = effects;
		setAmbientEnabled(this.ambient);
		setEffectsEnabled(this.effects);
	}

	setAmbient(on: boolean): void {
		this.ambient = on;
		persist(LS_AMBIENT, on);
		setAmbientEnabled(on);
	}

	setEffects(on: boolean): void {
		this.effects = on;
		persist(LS_EFFECTS, on);
		setEffectsEnabled(on);
	}

	toggleAmbient(): void {
		this.setAmbient(!this.ambient);
	}

	toggleEffects(): void {
		this.setEffects(!this.effects);
	}
}

export const audioSettings = new AudioSettings();

/** Applies the device's stored audio preferences. Call once, from the root
 * layout's onMount. */
export function initAudioSettings(): void {
	audioSettings.init();
}
