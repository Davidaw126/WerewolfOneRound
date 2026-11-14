<script lang="ts">
	// 情侣相认: every phone shows this same button (so screens can't give the
	// couple away), and the answer pops up only while it's held - like the
	// role card, gone the instant the finger lifts, slides off, or the app is
	// backgrounded.
	import { fade, scale } from 'svelte/transition';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { strings } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';

	const t = $derived(strings(i18n.lang));
	let pressing = $state(false);

	const press = () => (pressing = true);
	const release = () => (pressing = false);
</script>

<svelte:window
	onpointerup={release}
	onpointercancel={release}
	onblur={release}
	onvisibilitychange={() => {
		if (document.hidden) release();
	}}
/>

<button
	onpointerdown={press}
	onkeydown={(e) => {
		if ((e.key === 'Enter' || e.key === ' ') && !pressing) {
			e.preventDefault();
			press();
		}
	}}
	onkeyup={(e) => {
		if (e.key === 'Enter' || e.key === ' ') release();
	}}
	oncontextmenu={(e) => e.preventDefault()}
	class="btn-primary w-full touch-none select-none"
>
	{t.room.holdToViewCouple}
</button>

{#if pressing}
	<div class="overlay-backdrop" role="presentation" transition:fade={{ duration: 100 }}>
		<div
			class="overlay-panel panel space-y-4 px-6 py-8 text-center"
			role="dialog"
			aria-modal="true"
			aria-label={t.room.holdToViewCouple}
			transition:scale={{ duration: 150, start: 0.9 }}
		>
			{#if gameStore.myPartnerSeat !== null}
				<p class="text-4xl" aria-hidden="true">💕</p>
				<p class="font-display text-2xl font-bold text-lav">
					{t.room.coupleLinked(gameStore.myPartnerSeat)}
				</p>
			{:else}
				<p class="font-display text-2xl font-bold text-bone">{t.room.coupleNotLinked}</p>
			{/if}
			<p class="text-sm text-zinc-500">{t.roleReveal.releaseToHide}</p>
		</div>
	</div>
{/if}
