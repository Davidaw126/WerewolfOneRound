<script lang="ts">
	// The short notices - "you picked 7, close your eyes", an error - in one
	// small layer floating under the header. (Private results are a dialog:
	// InfoDialog.) It never pushes the page around, and taps go through
	// it to the seats and buttons underneath; tapping a notice itself just
	// dismisses it early. A plain fade, nothing that draws the eye across
	// the table.
	import { fade } from 'svelte/transition';
	import { gameStore } from '$lib/client/gameStore.svelte';
</script>

<div
	class="pointer-events-none fixed inset-x-0 z-40 mx-auto flex w-full max-w-lg flex-col items-stretch gap-2 px-4"
	style="top: calc(env(safe-area-inset-top, 0px) + 4.75rem)"
	aria-live="polite"
>
	{#if gameStore.confirmToast}
		<button
			transition:fade={{ duration: 150 }}
			onclick={() => (gameStore.confirmToast = null)}
			class="panel pointer-events-auto border-village/50 px-4 py-2 text-left text-sm text-village shadow-[0_6px_18px_rgba(0,0,0,0.55)]"
		>
			{gameStore.confirmToast}
		</button>
	{/if}
	{#if gameStore.toast}
		<button
			transition:fade={{ duration: 150 }}
			onclick={() => (gameStore.toast = null)}
			class="panel pointer-events-auto border-wolf/50 px-4 py-2 text-left text-sm text-wolf shadow-[0_6px_18px_rgba(0,0,0,0.55)]"
		>
			{gameStore.toast}
		</button>
	{/if}
</div>
