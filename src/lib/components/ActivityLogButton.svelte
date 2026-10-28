<script lang="ts">
	import { renderLine, renderRound } from '$lib/client/logLines';
	import { fade, scale } from 'svelte/transition';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { strings } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';

	const t = $derived(strings(i18n.lang));
	let open = $state(false);
</script>

<button onclick={() => (open = true)} class="btn-ghost btn-bar">
	<span>{t.activityLog.button}</span>
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
			aria-label={t.activityLog.title}
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			transition:scale={{ duration: 200, start: 0.85 }}
		>
			<h2 class="mb-3 font-display text-sm font-bold tracking-widest text-ember uppercase">
				{t.activityLog.title}
			</h2>
			<div class="min-h-0 flex-1 space-y-2 overflow-y-auto">
				{#if gameStore.activityLog.length === 0}
					<p class="text-sm text-zinc-500">{t.activityLog.empty}</p>
				{:else}
					{#each gameStore.activityLog as entry, i (i)}
						<div class="border-2 border-line bg-surface-2 px-3 py-2 text-xs">
							<div class="mb-1 flex items-center justify-between">
								<span class="text-ember">{renderRound(entry.round, i18n.lang)}</span>
								{#if entry.public}
									<span class="chip !px-1.5 !py-0.5 text-[10px]">{t.activityLog.publicChip}</span>
								{/if}
							</div>
							<div class="text-bone">{renderLine(entry.line, i18n.lang)}</div>
						</div>
					{/each}
				{/if}
			</div>
			<button onclick={() => (open = false)} class="btn-primary mt-4 w-full"
				>{t.activityLog.hide}</button
			>
		</div>
	</div>
{/if}
