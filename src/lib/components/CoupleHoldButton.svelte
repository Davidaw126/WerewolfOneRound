<script lang="ts">
	// 情侣相认: every phone shows this same button (so screens can't give the
	// couple away), and the answer shows only while it's held - like the
	// role card, gone the instant the finger lifts, slides off, or the app is
	// backgrounded.
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
	{#if pressing}
		{gameStore.myPartnerSeat !== null
			? `💕 ${t.room.coupleLinked(gameStore.myPartnerSeat)}`
			: t.room.coupleNotLinked}
	{:else}
		{t.room.holdToViewCouple}
	{/if}
</button>
