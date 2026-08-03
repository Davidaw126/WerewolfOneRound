<script lang="ts">
	import { scale } from 'svelte/transition';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import type { AckResponse } from '$lib/shared/events';

	let {
		mySeat,
		isHost
	}: {
		mySeat: number | null;
		isHost: boolean;
	} = $props();

	const roomState = $derived(gameStore.state);
	const seats = $derived(roomState?.seats ?? []);
	const votes = $derived(roomState?.votes ?? {});
	const livingSeats = $derived(seats.filter((s) => s.sessionId !== null && !s.isDead));
	const alreadyVoted = $derived(mySeat !== null && votes[mySeat] !== undefined);
	const iAmDead = $derived(mySeat !== null && seats.find((s) => s.seatNumber === mySeat)?.isDead);

	async function vote(target: number | 'abstain') {
		const res = await sendAction<AckResponse>({ kind: 'VoteCast', target });
		if (!res.ok) return;
		const description = target === 'abstain' ? '你选择了弃票' : `你投给了 ${target} 号`;
		gameStore.logActivity(description);
		// Page-level banner, not nested here - the grid itself stays visible
		// (via alreadyVoted's existing disable/highlight) so the live vote-count
		// badges keep updating instead of being hidden behind a "confirming" state.
		gameStore.showConfirm(`✓ ${description}`, 3000);
	}

	async function endVote() {
		await sendAction<AckResponse>({ kind: 'VoteEnd' });
	}
</script>

<div class="space-y-4">
	<h2 class="font-display text-lg font-semibold text-ember">白天投票</h2>

	<div class="grid grid-cols-4 gap-2">
		{#each livingSeats as seat (seat.seatNumber)}
			{@const voteCount = Object.values(votes).filter((v) => v === seat.seatNumber).length}
			<div class="relative">
				<button
					onclick={() => vote(seat.seatNumber)}
					disabled={mySeat === null || iAmDead || alreadyVoted}
					class="seat-btn w-full {votes[mySeat ?? -1] === seat.seatNumber
						? 'border-ember bg-ember/20 text-ember'
						: ''}"
				>
					{seat.seatNumber}号 {seat.username}
				</button>
				{#if voteCount > 0}
					{#key voteCount}
						<span
							in:scale={{ duration: 200, start: 0.4 }}
							class="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white"
						>
							{voteCount}
						</span>
					{/key}
				{/if}
			</div>
		{/each}
	</div>

	<button
		onclick={() => vote('abstain')}
		disabled={mySeat === null || iAmDead || alreadyVoted}
		class="btn-ghost w-full py-2 text-sm"
	>
		弃票
	</button>

	{#if isHost}
		<button onclick={endVote} class="btn-primary w-full">结束投票，公布结果</button>
	{/if}
</div>
