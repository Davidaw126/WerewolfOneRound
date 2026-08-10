<script lang="ts">
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { askConfirm } from '$lib/client/confirmDialog.svelte';
	import { strings, seatLabel } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';
	import type { AckResponse } from '$lib/shared/events';

	let { isHost }: { isHost: boolean } = $props();

	const t = $derived(strings(i18n.lang));
	const roomState = $derived(gameStore.state);
	const phase = $derived(roomState?.phase ?? null);
	const seats = $derived(roomState?.seats ?? []);
	const livingSeats = $derived(seats.filter((s) => s.sessionId !== null && !s.isDead));
	const currentSpeaker = $derived(roomState?.currentSpeaker ?? null);
	const speaker = $derived(seats.find((s) => s.seatNumber === currentSpeaker) ?? null);

	let explodeOpen = $state(false);
	let explodeSeat = $state<number | null>(null);
	let duelOpen = $state(false);
	let duelKnightSeat = $state<number | null>(null);
	let duelTargetSeat = $state<number | null>(null);

	async function nextSpeaker() {
		await sendAction<AckResponse>({ kind: 'DayNextSpeaker' });
	}

	async function beginVote() {
		await sendAction<AckResponse>({ kind: 'DayBeginVote' });
	}

	async function confirmExplode() {
		if (explodeSeat === null) return;
		if (!(await askConfirm(t.discussion.confirmExplode(explodeSeat)))) return;
		const res = await sendAction<AckResponse>({ kind: 'DaySelfExplode', seat: explodeSeat });
		if (res.ok) {
			explodeOpen = false;
			explodeSeat = null;
		}
	}

	async function confirmDuel() {
		if (duelKnightSeat === null || duelTargetSeat === null) return;
		if (!(await askConfirm(t.discussion.confirmDuel(duelKnightSeat, duelTargetSeat)))) return;
		const res = await sendAction<AckResponse>({
			kind: 'DayKnightDuel',
			knightSeat: duelKnightSeat,
			targetSeat: duelTargetSeat
		});
		if (res.ok) {
			duelOpen = false;
			duelKnightSeat = null;
			duelTargetSeat = null;
		}
	}
</script>

<div class="panel space-y-3 p-4">
	<h3 class="font-display text-lg font-semibold text-ember">
		{phase === 'LAST_WORDS' ? t.discussion.lastWordsTitle : t.discussion.discussionTitle}
	</h3>

	{#if speaker}
		<p class="text-center text-sm text-zinc-300">
			{t.discussion.currentSpeaker(speaker.seatNumber, speaker.username ?? '')}
		</p>
	{:else}
		<p class="text-center text-sm text-zinc-500">
			{phase === 'LAST_WORDS' ? t.discussion.lastWordsEnded : t.discussion.discussionEnded}
		</p>
	{/if}

	{#if isHost}
		<button onclick={nextSpeaker} class="btn-ghost w-full py-2 text-sm">{t.discussion.next}</button>

		{#if phase === 'DISCUSSION'}
			<button onclick={beginVote} class="btn-primary w-full">{t.discussion.startVote}</button>

			<div class="space-y-2 border-t border-white/10 pt-3">
				{#if !explodeOpen && !duelOpen}
					<div class="flex gap-2">
						<button onclick={() => (explodeOpen = true)} class="btn-ghost flex-1 py-2 text-xs">
							{t.discussion.selfExplodeButton}
						</button>
						<button onclick={() => (duelOpen = true)} class="btn-ghost flex-1 py-2 text-xs">
							{t.discussion.knightDuelButton}
						</button>
					</div>
				{/if}

				{#if explodeOpen}
					<div class="space-y-2">
						<p class="text-xs text-zinc-400">{t.discussion.selectExplodeSeat}</p>
						<div class="grid grid-cols-4 gap-2">
							{#each livingSeats as seat (seat.seatNumber)}
								<button
									onclick={() => (explodeSeat = seat.seatNumber)}
									class="seat-btn {explodeSeat === seat.seatNumber
										? 'border-wolf bg-wolf/20 text-wolf'
										: ''}"
								>
									{seatLabel(seat.seatNumber, i18n.lang)}
								</button>
							{/each}
						</div>
						<div class="flex gap-2">
							<button
								onclick={confirmExplode}
								disabled={explodeSeat === null}
								class="btn-primary flex-1 py-2 text-sm">{t.discussion.confirm}</button
							>
							<button
								onclick={() => {
									explodeOpen = false;
									explodeSeat = null;
								}}
								class="btn-ghost flex-1 py-2 text-sm">{t.discussion.cancel}</button
							>
						</div>
					</div>
				{/if}

				{#if duelOpen}
					<div class="space-y-2">
						<p class="text-xs text-zinc-400">{t.discussion.selectKnightSeat}</p>
						<div class="grid grid-cols-4 gap-2">
							{#each livingSeats as seat (seat.seatNumber)}
								<button
									onclick={() => (duelKnightSeat = seat.seatNumber)}
									class="seat-btn {duelKnightSeat === seat.seatNumber
										? 'border-ember bg-ember/20 text-ember'
										: ''}"
								>
									{seatLabel(seat.seatNumber, i18n.lang)}
								</button>
							{/each}
						</div>
						<p class="text-xs text-zinc-400">{t.discussion.selectDuelTargetSeat}</p>
						<div class="grid grid-cols-4 gap-2">
							{#each livingSeats as seat (seat.seatNumber)}
								<button
									onclick={() => (duelTargetSeat = seat.seatNumber)}
									disabled={seat.seatNumber === duelKnightSeat}
									class="seat-btn {duelTargetSeat === seat.seatNumber
										? 'border-wolf bg-wolf/20 text-wolf'
										: ''}"
								>
									{seatLabel(seat.seatNumber, i18n.lang)}
								</button>
							{/each}
						</div>
						<div class="flex gap-2">
							<button
								onclick={confirmDuel}
								disabled={duelKnightSeat === null || duelTargetSeat === null}
								class="btn-primary flex-1 py-2 text-sm">{t.discussion.confirm}</button
							>
							<button
								onclick={() => {
									duelOpen = false;
									duelKnightSeat = null;
									duelTargetSeat = null;
								}}
								class="btn-ghost flex-1 py-2 text-sm">{t.discussion.cancel}</button
							>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	{:else}
		<p class="text-center text-xs text-zinc-500">{t.discussion.waitingHost}</p>
	{/if}
</div>
