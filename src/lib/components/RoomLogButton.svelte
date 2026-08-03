<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { gameStore } from '$lib/client/gameStore.svelte';

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
	class="btn-ghost relative flex flex-1 items-center justify-center gap-2 py-2 text-xs"
>
	<span>🔔 房间动态</span>
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
			aria-label="房间动态"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			transition:scale={{ duration: 200, start: 0.85 }}
		>
			<h2 class="mb-3 font-display text-sm font-bold tracking-widest text-ember uppercase">
				房间动态
			</h2>
			<div class="min-h-0 flex-1 space-y-2 overflow-y-auto">
				{#if gameStore.roomLog.length === 0}
					<p class="text-sm text-zinc-500">暂无动态</p>
				{:else}
					{#each gameStore.roomLog as entry, i (i)}
						<div class="border-2 border-line bg-surface-2 px-3 py-2 text-xs">
							<div class="mb-1 text-ember">{entry.round}</div>
							<div class="text-bone">{entry.text}</div>
						</div>
					{/each}
				{/if}
			</div>
			<button onclick={() => (open = false)} class="btn-primary mt-4 w-full">隐藏</button>
		</div>
	</div>
{/if}
