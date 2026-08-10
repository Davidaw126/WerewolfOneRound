<script lang="ts">
	import { onMount } from 'svelte';
	import '../app.css';
	import { unlockAudio, sfxClick, narrationWatchdog } from '$lib/client/sfx';
	import { initAudioSettings } from '$lib/client/audioSettings.svelte';
	import { i18n } from '$lib/client/i18n.svelte';
	import ConfirmDialogHost from '$lib/components/ConfirmDialogHost.svelte';

	let { children } = $props();

	onMount(() => {
		initAudioSettings();
		i18n.syncDocumentLang();

		// Resume audio on the first gesture (autoplay policy) and give every
		// button a tactile 8-bit click without wiring each one individually.
		const onDown = (e: PointerEvent) => {
			unlockAudio();
			const t = e.target as HTMLElement | null;
			if (t && t.closest('button')) sfxClick();
		};
		window.addEventListener('pointerdown', onDown);

		// Deliberately does NOT suspend the AudioContext or pause speechSynthesis
		// when the tab/app goes to the background - the ambient drone and
		// narration keep playing while hidden. `resume()` (harmless no-op if
		// nothing needed it) and narrationWatchdog() still run on return, since
		// the BROWSER itself - independent of anything this app does - may still
		// silently kill speech synthesis while backgrounded on some mobile
		// engines; this is just recovery from that, not anything this app
		// initiates.
		const onVisible = () => {
			if (window.speechSynthesis) speechSynthesis.resume();
			narrationWatchdog();
		};
		const onVisibilityChange = () => {
			if (!document.hidden) onVisible();
		};
		document.addEventListener('visibilitychange', onVisibilityChange);
		// Mobile Safari's bfcache doesn't reliably fire visibilitychange.
		window.addEventListener('pageshow', onVisible);

		return () => {
			window.removeEventListener('pointerdown', onDown);
			document.removeEventListener('visibilitychange', onVisibilityChange);
			window.removeEventListener('pageshow', onVisible);
		};
	});
</script>

<div class="grain">
	{@render children()}
</div>

<ConfirmDialogHost />
