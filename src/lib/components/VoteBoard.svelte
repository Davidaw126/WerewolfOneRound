<script lang="ts">
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
	// S11: the server only ever tells us WHO has voted, never for whom or a
	// running tally - watching others' picks land live is exactly what this
	// screen must not show.
	const votedSeats = $derived(roomState?.votedSeats ?? []);
	const totalVoters = $derived(roomState?.totalVoters ?? 0);
	const pkCandidates = $derived(roomState?.pkCandidates ?? []);
	const inPk = $derived(pkCandidates.length > 0);
	// §9.4 平票处理: during a PK re-vote, only the tied candidates are valid
	// targets, and the candidates themselves can't vote.
	const targetSeats = $derived(
		seats.filter(
			(s) => s.sessionId !== null && !s.isDead && (!inPk || pkCandidates.includes(s.seatNumber))
		)
	);
	const alreadyVoted = $derived(mySeat !== null && votedSeats.includes(mySeat));
	const iAmDead = $derived(mySeat !== null && seats.find((s) => s.seatNumber === mySeat)?.isDead);
	const iAmPkCandidate = $derived(mySeat !== null && pkCandidates.includes(mySeat));

	// Client-local only (not server state) - purely so the button I picked
	// stays highlighted for me after I vote. Resets whenever a fresh vote
	// opens (mySeat no longer counted among votedSeats) so it can't bleed
	// into the next round; lost on a page refresh mid-vote, which is fine -
	// `alreadyVoted` above (server-authoritative) still correctly keeps the
	// buttons disabled either way.
	let myVoteTarget = $state<number | 'abstain' | null>(null);
	$effect(() => {
		if (!alreadyVoted) myVoteTarget = null;
	});

	async function vote(target: number | 'abstain') {
		const res = await sendAction<AckResponse>({ kind: 'VoteCast', target });
		if (!res.ok) return;
		myVoteTarget = target;
		const description = target === 'abstain' ? '你选择了弃票' : `你投给了 ${target} 号`;
		gameStore.logActivity(description);
		gameStore.showConfirm(`✓ ${description}`, 3000);
	}

	async function endVote() {
		await sendAction<AckResponse>({ kind: 'VoteEnd' });
	}
</script>

<div class="space-y-4">
	<div class="flex items-baseline justify-between">
		<h2 class="font-display text-lg font-semibold text-ember">
			{inPk ? 'PK 投票' : '白天投票'}
		</h2>
		<span class="text-xs text-zinc-500 tabular-nums">已投 {votedSeats.length}/{totalVoters} 人</span
		>
	</div>

	{#if iAmPkCandidate}
		<p class="text-center text-sm text-zinc-500">你是 PK 候选人，本轮不可投票</p>
	{:else}
		<div class="grid grid-cols-4 gap-2">
			{#each targetSeats as seat (seat.seatNumber)}
				<button
					onclick={() => vote(seat.seatNumber)}
					disabled={mySeat === null || iAmDead || alreadyVoted}
					class="seat-btn w-full {myVoteTarget === seat.seatNumber
						? 'border-ember bg-ember/20 text-ember'
						: ''}"
				>
					{seat.seatNumber}号 {seat.username}
				</button>
			{/each}
		</div>

		<button
			onclick={() => vote('abstain')}
			disabled={mySeat === null || iAmDead || alreadyVoted}
			class="btn-ghost w-full py-2 text-sm {myVoteTarget === 'abstain'
				? 'border-ember text-ember'
				: ''}"
		>
			弃票
		</button>
	{/if}

	{#if isHost}
		<button onclick={endVote} class="btn-primary w-full">结束投票，公布结果</button>
	{/if}
</div>
