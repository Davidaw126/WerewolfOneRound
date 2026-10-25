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
	/** Someone was exiled, or a self-explosion / duel ended the day. */
	const dayDecided = $derived(roomState?.dayDecided ?? false);
	// Hidden once the duel is spent - the server would only refuse it.
	const hasKnight = $derived(
		(roomState?.roleConfig?.['骑士'] ?? 0) > 0 && !(roomState?.knightUsed ?? false)
	);

	// Two pickers: the seats that left the table today (multi-select), or a
	// knight duel (knight, then target) - the one day move the table can't
	// settle by itself, since only the app knows whether the target is a wolf.
	type Mode = 'out' | 'duel';
	let mode = $state<Mode>('out');
	let outSeats = $state<number[]>([]);
	let duelTarget = $state<number | null>(null);
	let duelKnightSeat = $state<number | null>(null);
	let busy = $state(false);
	/** Someone was marked out today - 进入下一夜 then needs only a plain confirm. */
	let markedToday = $state(false);

	function setMode(next: Mode) {
		mode = next;
		outSeats = [];
		duelTarget = null;
		duelKnightSeat = null;
	}

	/** Every host action goes through here: a failure pops up via sendAction's
	 * global error handler, and `busy` stops a double tap sending it twice. */
	async function run(action: Parameters<typeof sendAction>[0]): Promise<boolean> {
		busy = true;
		const res = await sendAction<AckResponse>(action);
		busy = false;
		if (res.ok) setMode('out');
		return res.ok;
	}

	async function nextSpeaker() {
		await run({ kind: 'DayNextSpeaker' });
	}

	async function confirmPick() {
		if (mode === 'out') {
			if (outSeats.length === 0) return;
			const seatsSorted = [...outSeats].sort((a, b) => a - b);
			if (!(await askConfirm(t.discussion.confirmOut(seatsSorted)))) return;
			if (await run({ kind: 'DayOut', seats: seatsSorted })) markedToday = true;
		} else if (duelKnightSeat !== null && duelTarget !== null) {
			if (!(await askConfirm(t.discussion.confirmDuel(duelKnightSeat, duelTarget)))) return;
			await run({ kind: 'DayKnightDuel', knightSeat: duelKnightSeat, targetSeat: duelTarget });
		}
	}

	async function enterNight() {
		// Night can't be undone, so always one confirm - worded more firmly
		// when nobody has left the table today.
		const prompt =
			markedToday || dayDecided
				? t.discussion.confirmEnterNightPlain
				: t.discussion.confirmEnterNight;
		if (!(await askConfirm(prompt))) return;
		if (await run({ kind: 'DayEndDay' })) markedToday = false;
	}

	function tapSeat(seatNumber: number) {
		if (mode === 'duel') {
			if (duelKnightSeat === null) duelKnightSeat = seatNumber;
			else duelTarget = duelTarget === seatNumber ? null : seatNumber;
			return;
		}
		outSeats = outSeats.includes(seatNumber)
			? outSeats.filter((s) => s !== seatNumber)
			: [...outSeats, seatNumber];
	}

	const isPicked = (seatNumber: number) =>
		mode === 'out' ? outSeats.includes(seatNumber) : duelTarget === seatNumber;

	const prompt = $derived(
		mode === 'out'
			? t.discussion.outHeader
			: duelKnightSeat === null
				? t.discussion.selectKnightSeat
				: t.discussion.selectDuelTargetSeat
	);

	const canConfirm = $derived(mode === 'out' ? outSeats.length > 0 : duelTarget !== null);
	const confirmLabel = $derived(
		mode === 'out'
			? outSeats.length === 0
				? t.discussion.outPickFirst
				: t.discussion.outButton([...outSeats].sort((a, b) => a - b))
			: t.discussion.confirm
	);
</script>

<div class="panel space-y-3 p-4">
	<h3 class="font-display text-lg font-semibold text-ember">
		{phase === 'LAST_WORDS' ? t.discussion.lastWordsTitle : t.discussion.dayTitle}
	</h3>

	{#if phase === 'LAST_WORDS'}
		<!-- Only reachable with a 遗言 rule switched back on. -->
		{#if speaker}
			<p class="text-center text-sm text-zinc-300">
				{t.discussion.currentSpeaker(speaker.seatNumber, speaker.username ?? '')}
			</p>
		{:else}
			<p class="text-center text-sm text-zinc-500">{t.discussion.lastWordsEnded}</p>
		{/if}
		{#if isHost}
			<button onclick={nextSpeaker} disabled={busy} class="btn-ghost w-full py-2 text-sm"
				>{t.discussion.next}</button
			>
		{:else}
			<p class="text-center text-xs text-zinc-500">{t.discussion.waitingHost}</p>
		{/if}
	{:else if !isHost}
		<p class="text-center text-sm text-zinc-500">
			{dayDecided ? t.discussion.dayDecided : t.discussion.playerWaiting}
		</p>
	{:else}
		<p class="text-xs text-zinc-400">{prompt}</p>
		{#if mode === 'out'}
			<p class="text-[11px] leading-snug text-zinc-500">{t.discussion.outHint}</p>
		{/if}
		<div class="grid grid-cols-4 gap-2">
			{#each livingSeats as seat (seat.seatNumber)}
				{@const isKnight = mode === 'duel' && duelKnightSeat === seat.seatNumber}
				<button
					onclick={() => tapSeat(seat.seatNumber)}
					disabled={busy || isKnight}
					class="seat-btn {isPicked(seat.seatNumber)
						? 'border-wolf bg-wolf/20 text-wolf'
						: isKnight
							? 'border-ember bg-ember/20 text-ember'
							: ''}"
				>
					{seatLabel(seat.seatNumber, i18n.lang)}
				</button>
			{/each}
		</div>
		<div class="flex gap-2">
			<button
				onclick={confirmPick}
				disabled={busy || !canConfirm}
				class="btn-primary flex-1 py-2 text-sm">{confirmLabel}</button
			>
			{#if mode !== 'out'}
				<button onclick={() => setMode('out')} class="btn-ghost flex-1 py-2 text-sm"
					>{t.discussion.cancel}</button
				>
			{/if}
		</div>
		{#if mode === 'out' && hasKnight && !dayDecided}
			<button onclick={() => setMode('duel')} class="btn-ghost w-full py-2 text-xs">
				{t.discussion.knightDuelButton}
			</button>
		{/if}

		<button
			onclick={enterNight}
			disabled={busy}
			class="{markedToday || dayDecided ? 'btn-primary' : 'btn-ghost'} w-full py-2 text-sm"
			>{t.discussion.enterNight}</button
		>
	{/if}
</div>
