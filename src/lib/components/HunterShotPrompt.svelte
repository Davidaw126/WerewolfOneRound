<script lang="ts">
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { strings, seatLabel } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';
	import type { AckResponse } from '$lib/shared/events';

	const t = $derived(strings(i18n.lang));
	const seats = $derived(gameStore.state?.seats ?? []);
	const hunterSeat = $derived(gameStore.state?.hunterSeat ?? null);
	const livingSeats = $derived(
		seats.filter((s) => s.sessionId !== null && !s.isDead && s.seatNumber !== hunterSeat)
	);

	let submitted = $state(false);

	async function shoot(target: number | null) {
		submitted = true;
		const res = await sendAction<AckResponse>({ kind: 'HunterShoot', target });
		if (!res.ok) {
			submitted = false;
			return;
		}
		const description = target === null ? t.hunterShot.descNoShoot : t.hunterShot.descShot(target);
		gameStore.logActivity(description);
		// Page-level banner, not nested here - hunter-shot resolution has no
		// server-side pause at all, so gameStore.hunterAuthorized can flip false
		// (unmounting this component) almost immediately after the ack, well
		// before any locally-nested confirmation text would ever be seen.
		gameStore.showConfirm(`✓ ${description}`, 3000);
	}
</script>

{#if gameStore.hunterAuthorized}
	<div class="panel space-y-3 border-wolf/40 p-4">
		<h3 class="font-display text-lg font-semibold text-wolf">
			{t.hunterShot.promptTitle}
		</h3>
		{#if submitted}
			<p class="text-sm text-zinc-400">{t.hunterShot.submitted}</p>
		{:else}
			<div class="grid grid-cols-4 gap-2">
				{#each livingSeats as seat (seat.seatNumber)}
					<button onclick={() => shoot(seat.seatNumber)} class="seat-btn hover:border-wolf/60">
						{seatLabel(seat.seatNumber, i18n.lang)}
						{seat.username}
					</button>
				{/each}
			</div>
			<button onclick={() => shoot(null)} class="btn-ghost w-full py-2 text-sm">
				{t.hunterShot.noShoot}
			</button>
		{/if}
	</div>
{:else if hunterSeat !== null}
	<div class="panel p-4 text-center text-sm text-zinc-400">
		{t.hunterShot.waitingFor(hunterSeat)}
	</div>
{/if}
