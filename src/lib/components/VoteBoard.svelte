<script lang="ts">
	// The day's ballot (the room's inAppVote rule): tap a seat on the circle,
	// confirm, or abstain. One vote per round. The Host also closes the vote,
	// or calls it off and goes to night. Nobody sees a running tally - only how
	// many have voted (S11); who voted for whom is told when it closes.
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { askConfirm } from '$lib/client/confirmDialog.svelte';
	import { strings, seatLabel } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';
	import { renderLine } from '$lib/client/logLines';
	import { VoteDraft } from '$lib/client/turnDraft.svelte';
	import { seatPick } from '$lib/client/seatPick.svelte';

	const t = $derived(strings(i18n.lang));

	const isHost = $derived(gameStore.isHost);
	const view = $derived(gameStore.voteView);
	const pk = $derived(gameStore.state?.pkCandidates ?? []);
	// A plain boolean, so the draft below is only rebuilt when the round
	// changes - not on every vote count update (view is a new object each time).
	const inPk = $derived(view.inPk);

	// What this phone voted - shown after the server took it (see
	// client/turnDraft.svelte.ts). A new round (PK) starts a fresh draft.
	const draft = $derived.by(() => {
		void inPk;
		return new VoteDraft();
	});
	let target = $state<number | null>(null);
	let busy = $state(false);
	$effect(() => {
		void inPk;
		target = null;
	});

	$effect(() => {
		if (!view.canVote || busy) return;
		return seatPick.claim({
			pickable: (n) => view.targets.some((s) => s.seatNumber === n),
			picked: (n) => (target === n ? 'ember' : null),
			tap: (n) => (target = target === n ? null : n)
		});
	});

	async function vote(choice: number | 'abstain') {
		const d = draft;
		const { action, entry } = d.submission(choice);
		busy = true;
		const res = await sendAction(action);
		busy = false;
		if (!res.ok) return;
		d.accepted(choice);
		gameStore.logActivity(entry);
		gameStore.showConfirm(`✓ ${renderLine(entry, i18n.lang)}`, 3000);
	}

	async function endVote() {
		busy = true;
		await sendAction({ kind: 'VoteEnd' });
		busy = false;
	}

	async function enterNight() {
		if (!(await askConfirm(t.vote.confirmCancelVote))) return;
		await sendAction({ kind: 'DayEndDay' });
	}

	const mine = $derived(draft.mine(view.alreadyVoted));
</script>

<div class="panel space-y-3 p-4">
	<div class="flex items-baseline justify-between">
		<h3 class="font-display text-lg font-semibold text-ember">
			{view.inPk ? t.vote.pkBetween(pk) : t.vote.day}
		</h3>
		<span class="text-sm text-zinc-400 tabular-nums"
			>{t.vote.votedCount(view.votedCount, view.totalVoters)}</span
		>
	</div>

	{#if view.revealedIdiot}
		<p class="text-sm text-zinc-400">{t.vote.revealedIdiotNote}</p>
	{:else if view.pkCandidate}
		<p class="text-sm text-zinc-400">{t.vote.pkCandidateNote}</p>
	{:else if view.alreadyVoted}
		<p class="text-base font-semibold text-village">
			{mine === 'abstain'
				? t.vote.myVoteAbstain
				: mine !== null
					? t.vote.myVoteFor(mine)
					: t.vote.voted}
		</p>
	{:else if view.canVote}
		<p class="text-base font-semibold text-bone">
			{target !== null ? t.nightPrompt.pickedSeats(seatLabel(target, i18n.lang)) : t.vote.tapSeat}
		</p>
		<button
			onclick={() => target !== null && vote(target)}
			disabled={busy || target === null}
			class="btn-primary w-full"
		>
			{target !== null ? t.vote.voteFor(target) : t.vote.pickFirst}
		</button>
		<button onclick={() => vote('abstain')} disabled={busy} class="btn-ghost w-full py-2 text-sm">
			{t.vote.abstain}
		</button>
	{:else}
		<p class="text-sm text-zinc-400">{t.vote.cannotVote}</p>
	{/if}

	{#if isHost}
		<div class="space-y-2 border-t-2 border-line/50 pt-3">
			<button onclick={endVote} disabled={busy} class="btn-primary w-full">
				{t.vote.endVote}
			</button>
			<button onclick={enterNight} disabled={busy} class="btn-ghost w-full py-2 text-sm">
				{t.vote.cancelVote}
			</button>
		</div>
	{/if}
</div>
