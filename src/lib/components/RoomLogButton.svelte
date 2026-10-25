<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { strings } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';

	const t = $derived(strings(i18n.lang));
	let open = $state(false);
	let lastSeenCount = $state(0);

	const unseen = $derived(gameStore.roomLog.length > lastSeenCount);

	function show() {
		open = true;
		lastSeenCount = gameStore.roomLog.length;
	}
</script>

<button
	onclick={show}
	class="btn-ghost relative flex min-w-0 flex-1 flex-wrap items-center justify-center gap-x-2 px-2! py-2 text-xs tracking-normal! [word-break:keep-all]"
>
	<span>{t.roomLog.button}</span>
	{#if unseen}
		<span class="absolute top-1 right-2 h-2 w-2 rounded-full bg-wolf"></span>
	{/if}
</button>

{#if open}
	<div
		class="overlay-backdrop"
		role="presentation"
		onclick={() => (open = false)}
		transition:fade={{ duration: 150 }}
	>
		<div
			class="overlay-panel panel flex max-h-[75dvh] flex-col p-4"
			role="dialog"
			aria-modal="true"
			aria-label={t.roomLog.title}
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			transition:scale={{ duration: 200, start: 0.85 }}
		>
			<h2 class="mb-3 font-display text-sm font-bold tracking-widest text-ember uppercase">
				{t.roomLog.title}
			</h2>
			<div class="min-h-0 flex-1 space-y-2 overflow-y-auto">
				{#if gameStore.roomLog.length === 0}
					<p class="text-sm text-zinc-500">{t.roomLog.empty}</p>
				{:else}
					{#each gameStore.roomLog as entry, i (i)}
						<div class="border-2 border-line bg-surface-2 px-3 py-2 text-xs">
							<div class="mb-1 text-ember">{entry.round}</div>
							<div class="text-bone">{entry.text}</div>
						</div>
					{/each}
				{/if}
			</div>
			<button onclick={() => (open = false)} class="btn-primary mt-4 w-full"
				>{t.roomLog.hide}</button
			>
		</div>
	</div>
{/if}
