<script lang="ts">
	// The Host's 自爆 at dawn: the table may be electing its 警长 before the
	// night's news, and a wolf can explode then. Lists every seat the table
	// thinks is alive, last night's unannounced deaths included.
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { askConfirm } from '$lib/client/confirmDialog.svelte';
	import { strings, seatLabel } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';

	const t = $derived(strings(i18n.lang).room);
	const seats = $derived(
		(gameStore.state?.seats ?? []).filter((s) => s.sessionId !== null && !s.isDead)
	);
	let picking = $state(false);
	let busy = $state(false);

	async function pick(seat: number) {
		if (!(await askConfirm(t.dawnExplodeConfirm(seat)))) return;
		busy = true;
		const res = await sendAction({ kind: 'DaySelfExplode', seat });
		busy = false;
		if (res.ok) picking = false;
	}
</script>

{#if gameStore.state?.dayDecided}
	<p class="text-center text-xs text-zinc-400">{t.dawnExploded}</p>
{:else if picking}
	<div class="panel space-y-2 p-3">
		<p class="text-xs text-zinc-400">{t.dawnExplodePick}</p>
		<div class="grid grid-cols-4 gap-2">
			{#each seats as seat (seat.seatNumber)}
				<button onclick={() => pick(seat.seatNumber)} disabled={busy} class="seat-btn">
					{seatLabel(seat.seatNumber, i18n.lang)}
				</button>
			{/each}
		</div>
		<button onclick={() => (picking = false)} class="btn-ghost w-full py-2 text-xs">
			{strings(i18n.lang).discussion.cancel}
		</button>
	</div>
{:else}
	<button onclick={() => (picking = true)} class="btn-ghost w-full py-2 text-xs">
		{t.dawnExplodeButton}
	</button>
{/if}
