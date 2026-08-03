<script lang="ts">
	import { onMount } from 'svelte';
	import '../app.css';
	import {
		unlockAudio,
		sfxClick,
		suspendAudio,
		resumeAudio,
		narrationWatchdog
	} from '$lib/client/sfx';
	import { initAudioSettings } from '$lib/client/audioSettings.svelte';
	import ConfirmDialogHost from '$lib/components/ConfirmDialogHost.svelte';

	let { children } = $props();

	onMount(() => {
		initAudioSettings();

		// Resume audio on the first gesture (autoplay policy) and give every
		// button a tactile 8-bit click without wiring each one individually.
		const onDown = (e: PointerEvent) => {
			unlockAudio();
			const t = e.target as HTMLElement | null;
			if (t && t.closest('button')) sfxClick();
		};
		window.addEventListener('pointerdown', onDown);

		// Nothing used to stop the audio when the page went to the background:
		// SPA navigation away tore the drone down, but merely hiding the tab
		// left the AudioContext rendering and speechSynthesis talking. Lives
		// here rather than on the room page because the AudioContext is
		// module-global, and a hidden tab's queued narration would otherwise
		// keep running after navigating away from the room.
		const onHidden = () => {
			suspendAudio();
			// Freeze rather than cancel: cancel() fires onend, so the queue would
			// march on while hidden - and killing an utterance before its onstart
			// would strand every other player waiting on that relayed signal.
			if (window.speechSynthesis) speechSynthesis.pause();
		};
		const onVisible = () => {
			resumeAudio();
			if (window.speechSynthesis) speechSynthesis.resume();
			narrationWatchdog();
		};
		const onVisibilityChange = () => (document.hidden ? onHidden() : onVisible());

		document.addEventListener('visibilitychange', onVisibilityChange);
		// Mobile Safari's bfcache doesn't reliably fire visibilitychange.
		window.addEventListener('pagehide', onHidden);
		window.addEventListener('pageshow', onVisible);

		return () => {
			window.removeEventListener('pointerdown', onDown);
			document.removeEventListener('visibilitychange', onVisibilityChange);
			window.removeEventListener('pagehide', onHidden);
			window.removeEventListener('pageshow', onVisible);
		};
	});
</script>

<div class="grain">
	{@render children()}
</div>

<ConfirmDialogHost />
