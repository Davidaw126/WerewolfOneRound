<script lang="ts">
	import { onMount } from 'svelte';
	import '../app.css';
	import { hostVoice } from '$lib/client/hostVoice';
	import { initAudioSettings } from '$lib/client/audioSettings.svelte';
	import { i18n } from '$lib/client/i18n.svelte';
	import ConfirmDialogHost from '$lib/components/ConfirmDialogHost.svelte';

	let { children } = $props();

	onMount(() => {
		initAudioSettings();
		i18n.syncDocumentLang();

		// Unlock the voice on the END of any tap, app-wide (iOS only counts
		// touchend / click / pointerup as activations) - the lobby, the seat
		// circle, before the Host's narration even exists. Capture phase, so
		// nothing that stops a tap's propagation can swallow it. Retried on
		// every tap until it sticks.
		const onTap = () => hostVoice.prime();
		const gestures = ['pointerup', 'touchend', 'click', 'keydown'] as const;
		for (const g of gestures) window.addEventListener(g, onTap, { capture: true });

		// Narration keeps playing in the background on purpose. Coming back,
		// wake the engine and move on from a line it dropped silently.
		const onVisible = () => hostVoice.wake();
		const onVisibilityChange = () => {
			if (!document.hidden) onVisible();
		};
		document.addEventListener('visibilitychange', onVisibilityChange);
		// Mobile Safari's bfcache doesn't reliably fire visibilitychange.
		window.addEventListener('pageshow', onVisible);

		return () => {
			for (const g of gestures) window.removeEventListener(g, onTap, { capture: true });
			document.removeEventListener('visibilitychange', onVisibilityChange);
			window.removeEventListener('pageshow', onVisible);
		};
	});
</script>

<div class="grain">
	{@render children()}
</div>

<ConfirmDialogHost />
