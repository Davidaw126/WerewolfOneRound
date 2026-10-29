<script lang="ts">
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { askConfirm } from '$lib/client/confirmDialog.svelte';
	import { strings, seatLabel } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';
	import { renderLine } from '$lib/client/logLines';
	import { VoteDraft } from '$lib/client/turnDraft.svelte';

	const t = $derived(strings(i18n.lang));

	const isHost = $derived(gameStore.isHost);
	const view = $derived(gameStore.voteView);
	const alreadyVoted = $derived(view.alreadyVoted);

	// Which button this phone voted - lit only while the server still counts
	// the vote, so a new round starts unlit (see client/turnDraft.svelte.ts).
	const draft = new VoteDraft();

	async function vote(target: number | 'abstain') {
		const { action, entry } = draft.submission(target);
		const res = await sendAction(action);
		if (!res.ok) return;
		draft.accepted(target);
		gameStore.logActivity(entry);
		gameStore.showConfirm(`✓ ${renderLine(entry, i18n.lang)}`, 3000);
	}

	async function endVote() {
		await sendAction({ kind: 'VoteEnd' });
	}

	async function enterNight() {
		if (!(await askConfirm(t.discussion.confirmEnterNight))) return;
		await sendAction({ kind: 'DayEndDay' });
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
					class="seat-btn w-full {draft.lit(seat.seatNumber, alreadyVoted)
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
			class="btn-ghost w-full py-2 text-sm {draft.lit('abstain', alreadyVoted)
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
