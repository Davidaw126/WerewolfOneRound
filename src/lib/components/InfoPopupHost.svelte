<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { gameStore } from '$lib/client/gameStore.svelte';

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
			class="overlay-panel panel px-6 py-8 text-center"
			role="dialog"
			aria-modal="true"
			aria-label="提示"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			transition:scale={{ duration: 200, start: 0.85 }}
		>
			<p class="text-lg font-semibold {toneClass}">{gameStore.infoPopup.message}</p>
		</div>
	</div>
{/if}
