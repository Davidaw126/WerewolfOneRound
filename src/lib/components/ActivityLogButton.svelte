<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { gameStore } from '$lib/client/gameStore.svelte';

	let open = $state(false);
</script>

<button
	onclick={() => (open = true)}
	class="btn-ghost flex flex-1 items-center justify-center gap-2 py-2 text-xs"
>
	<span>📜 我的记录</span>
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
			aria-label="我的记录"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			transition:scale={{ duration: 200, start: 0.85 }}
		>
			<h2 class="mb-3 font-display text-sm font-bold tracking-widest text-ember uppercase">
				我的记录
			</h2>
			<div class="min-h-0 flex-1 space-y-2 overflow-y-auto">
				{#if gameStore.activityLog.length === 0}
					<p class="text-sm text-zinc-500">暂无记录</p>
				{:else}
					{#each gameStore.activityLog as entry, i (i)}
						<div class="border-2 border-line bg-surface-2 px-3 py-2 text-xs">
							<div class="mb-1 flex items-center justify-between">
								<span class="text-ember">{entry.round}</span>
								{#if entry.public}
									<span class="chip !px-1.5 !py-0.5 text-[10px]">公开</span>
								{/if}
							</div>
							<div class="text-bone">{entry.text}</div>
						</div>
					{/each}
				{/if}
			</div>
			<button onclick={() => (open = false)} class="btn-primary mt-4 w-full">隐藏</button>
		</div>
	</div>
{/if}
