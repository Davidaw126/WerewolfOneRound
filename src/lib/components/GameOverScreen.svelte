<script lang="ts">
	import { gameStore } from '$lib/client/gameStore.svelte';
	import RoleFace from './RoleFace.svelte';

	const result = $derived(gameStore.gameOverResult);
	const seats = $derived(gameStore.state?.seats ?? []);
	// §11.4 enriched GAME_OVER screen - the room log already narrates every
	// public event (deaths, votes, hunter shots, self-explodes, overrides)
	// through the whole game; surfacing it here means nobody has to dig for
	// "房间动态" separately right when it matters most.
	const timeline = $derived(gameStore.roomLog);
</script>

{#if result}
	<div class="space-y-5 text-center">
		<h2
			class="font-display text-4xl font-black {result.winner === 'wolves'
				? 'title-glow text-wolf'
				: result.winner === 'lovers'
					? 'text-lav'
					: 'text-village'}"
			style={result.winner === 'wolves'
				? ''
				: result.winner === 'lovers'
					? 'text-shadow:0 0 24px rgba(184,161,255,0.45)'
					: 'text-shadow:0 0 24px rgba(232,195,122,0.45)'}
		>
			{result.winner === 'wolves'
				? '狼人阵营胜利'
				: result.winner === 'lovers'
					? '第三方阵营胜利'
					: '好人阵营胜利'}
		</h2>

		<div class="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3">
			{#each seats as seat (seat.seatNumber)}
				{@const role = result.identities[seat.seatNumber]}
				{@const isCouple = result.coupleSeats?.includes(seat.seatNumber) ?? false}
				<div class="relative space-y-1.5">
					{#if isCouple}
						<span class="absolute -top-1.5 -right-1 z-10 text-[13px]" title="情侣">💕</span>
					{/if}
					<div class="line-clamp-2 min-h-8 text-xs text-zinc-500">
						{seat.seatNumber}号 {seat.username ?? ''}
					</div>
					{#if role}
						<RoleFace {role} size="sm" />
					{:else}
						<div class="panel px-2 py-3 text-sm text-zinc-500">未知</div>
					{/if}
				</div>
			{/each}
		</div>

		{#if timeline.length > 0}
			<div class="space-y-2 text-left">
				<h3 class="font-display text-sm font-bold tracking-widest text-ember uppercase">
					本局回顾
				</h3>
				<div class="max-h-[40dvh] space-y-2 overflow-y-auto">
					{#each timeline as entry, i (i)}
						<div class="border-2 border-line bg-surface-2 px-3 py-2 text-xs">
							<div class="mb-1 text-ember">{entry.round}</div>
							<div class="text-bone">{entry.text}</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
{/if}
