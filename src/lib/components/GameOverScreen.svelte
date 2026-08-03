<script lang="ts">
	import { gameStore } from '$lib/client/gameStore.svelte';
	import RoleFace from './RoleFace.svelte';

	const result = $derived(gameStore.gameOverResult);
	const seats = $derived(gameStore.state?.seats ?? []);
</script>

{#if result}
	<div class="space-y-5 text-center">
		<h2
			class="font-display text-4xl font-black {result.winner === 'wolves'
				? 'title-glow text-wolf'
				: 'text-village'}"
			style={result.winner === 'wolves' ? '' : 'text-shadow:0 0 24px rgba(232,195,122,0.45)'}
		>
			{result.winner === 'wolves' ? '狼人阵营胜利' : '好人阵营胜利'}
		</h2>

		<div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
			{#each seats as seat (seat.seatNumber)}
				{@const role = result.identities[seat.seatNumber]}
				<div class="space-y-1">
					<div class="text-xs text-zinc-500">{seat.seatNumber}号 {seat.username ?? ''}</div>
					{#if role}
						<RoleFace {role} size="sm" />
					{:else}
						<div class="panel px-2 py-3 text-sm text-zinc-500">未知</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>
{/if}
