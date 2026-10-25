<script lang="ts">
	import { onMount } from 'svelte';
	import '../app.css';
	import { primeSpeech, narrationWatchdog } from '$lib/client/sfx';
	import { initAudioSettings } from '$lib/client/audioSettings.svelte';
	import { i18n } from '$lib/client/i18n.svelte';
	import ConfirmDialogHost from '$lib/components/ConfirmDialogHost.svelte';

	let { children } = $props();

	onMount(() => {
		initAudioSettings();
		i18n.syncDocumentLang();

		// Unlock speech on the END of a tap, app-wide, so a tap anywhere - the
		// lobby, the seat circle, before the judge view even exists - counts.
		// iOS only accepts touchend/click/pointerup as activations (never
		// pointerdown). Mobile Safari and Chrome both refuse speechSynthesis
		// until one has happened; primeSpeech retries on every tap until it
		// sticks.
		const onDown = () => primeSpeech();
		const gestures = ['pointerup', 'touchend', 'click', 'keydown'] as const;
		for (const g of gestures) window.addEventListener(g, onDown);

		// Deliberately does NOT pause speechSynthesis when the tab/app goes to
		// the background - narration keeps playing while hidden. `resume()`
		// (harmless no-op if nothing needed it) and narrationWatchdog() still
		// run on return, since
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
			for (const g of gestures) window.removeEventListener(g, onDown);
			document.removeEventListener('visibilitychange', onVisibilityChange);
			window.removeEventListener('pageshow', onVisible);
		};
	});
</script>

<div class="grain">
	{@render children()}
</div>

<ConfirmDialogHost />
