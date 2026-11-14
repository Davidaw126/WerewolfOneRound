<script lang="ts">
	// A private result, said plainly: the 预言家's check, the 猎人's shot,
	// a role change, 野孩子 joining the pack. A centered dialog over a dimmed
	// screen, in large type, until tapped away (some also close on their
	// own - see gameStore.showInfoPopup). The quick "you picked 7, close
	// your eyes" confirmations stay in NoticeLayer's small floating strip.
	import { fade, scale } from 'svelte/transition';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { strings } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';

	const t = $derived(strings(i18n.lang));
	const toneClass = $derived(
		gameStore.infoPopup?.tone === 'bad'
			? 'text-wolf'
			: gameStore.infoPopup?.tone === 'good'
				? 'text-village'
				: 'text-bone'
	);
</script>

{#if gameStore.infoPopup}
	<div
		class="overlay-backdrop"
		role="presentation"
		onclick={() => gameStore.dismissInfoPopup()}
		transition:fade={{ duration: 150 }}
	>
		<div
			class="overlay-panel panel space-y-6 px-6 py-8 text-center"
			role="dialog"
			aria-modal="true"
			aria-label={gameStore.infoPopup.message}
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			transition:scale={{ duration: 150, start: 0.9 }}
		>
			<p class="font-display text-2xl leading-snug font-bold {toneClass}">
				{gameStore.infoPopup.message}
			</p>
			<button onclick={() => gameStore.dismissInfoPopup()} class="btn-primary w-full">
				{t.common.ok}
			</button>
		</div>
	</div>
{/if}
