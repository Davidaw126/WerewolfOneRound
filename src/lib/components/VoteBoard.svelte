<script lang="ts">
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { askConfirm } from '$lib/client/confirmDialog.svelte';
	import { strings, seatLabel } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';
	import type { AckResponse } from '$lib/shared/events';
	import { line as logLine, renderLine } from '$lib/client/logLines';

	const t = $derived(strings(i18n.lang));

	const isHost = $derived(gameStore.isHost);
	const view = $derived(gameStore.voteView);
	const alreadyVoted = $derived(view.alreadyVoted);

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
		const entry =
			target === 'abstain'
				? logLine('text', 'vote', 'myVoteAbstain')
				: logLine('text', 'vote', 'myVoteFor', target);
		gameStore.logActivity(entry);
		gameStore.showConfirm(`✓ ${renderLine(entry, i18n.lang)}`, 3000);
	}

	async function endVote() {
		await sendAction<AckResponse>({ kind: 'VoteEnd' });
	}

	async function enterNight() {
		if (!(await askConfirm(t.discussion.confirmEnterNight))) return;
		await sendAction<AckResponse>({ kind: 'DayEndDay' });
	}
</script>

<div class="space-y-4">
	<div class="flex items-baseline justify-between">
		<h2 class="font-display text-lg font-semibold text-ember">
			{view.inPk ? t.vote.pk : t.vote.day}
		</h2>
		<span class="text-xs text-zinc-500 tabular-nums"
			>{t.vote.votedCount(view.votedCount, view.totalVoters)}</span
		>
	</div>

	{#if view.revealedIdiot}
		<p class="text-center text-sm text-zinc-500">{t.vote.revealedIdiotNote}</p>
	{/if}
	{#if view.pkCandidate}
		<p class="text-center text-sm text-zinc-500">{t.vote.pkCandidateNote}</p>
	{:else}
		<div class="grid grid-cols-4 gap-2">
			{#each view.targets as seat (seat.seatNumber)}
				<button
					onclick={() => vote(seat.seatNumber)}
					disabled={!view.canVote}
					class="seat-btn w-full {myVoteTarget === seat.seatNumber
						? 'border-ember bg-ember/20 text-ember'
						: ''}"
				>
					{seatLabel(seat.seatNumber, i18n.lang)}
					{seat.username}
				</button>
			{/each}
		</div>

		<button
			onclick={() => vote('abstain')}
			disabled={!view.canVote}
			class="btn-ghost w-full py-2 text-sm {myVoteTarget === 'abstain'
				? 'border-ember text-ember'
				: ''}"
		>
			{t.vote.abstain}
		</button>
	{/if}

	{#if isHost}
		<button onclick={endVote} class="btn-primary w-full">{t.vote.endVote}</button>
		<button onclick={enterNight} class="btn-ghost w-full py-2 text-sm"
			>{t.discussion.enterNight}</button
		>
	{/if}
</div>
