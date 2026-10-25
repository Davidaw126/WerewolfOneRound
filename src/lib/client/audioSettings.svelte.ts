// The judge-voice preference, persisted per device. Mirrors the
// confirmDialog store's shape: a rune-backed class, one singleton, and thin
// function wrappers, initialised once from the root layout.

import { setEffectsEnabled } from './sfx';

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
	/** sound effects, and (on the host's device) spoken narration. */
	effects = $state(true);

	/**
	 * Loads the stored preference and pushes it into sfx.ts. Must be called from
	 * onMount rather than the constructor - this module is imported during SSR,
	 * where the singleton is constructed but localStorage doesn't exist.
	 *
	 * Defaults to on, so the pre-hydration render matches the app's
	 * long-standing behaviour; a muted user sees the icon flip once on hydrate,
	 * which is unavoidable without moving the preference to a cookie.
	 */
	init(): void {
		const effects = readStored(LS_EFFECTS);
		if (effects !== null) this.effects = effects;
		setEffectsEnabled(this.effects);
	}

	setEffects(on: boolean): void {
		this.effects = on;
		persist(LS_EFFECTS, on);
		setEffectsEnabled(on);
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
