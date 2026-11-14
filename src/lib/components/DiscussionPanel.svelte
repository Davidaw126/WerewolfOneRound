<script lang="ts">
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { askConfirm } from '$lib/client/confirmDialog.svelte';
	import { strings, seatLabel } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';
	import { seatPick } from '$lib/client/seatPick.svelte';

	const isHost = $derived(gameStore.isHost);

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
	// The room's rule: the vote happens on the phones, opened by the Host.
	const inAppVote = $derived(roomState?.inAppVote === true);
	const hasKnight = $derived(
		(roomState?.roleConfig?.['KNIGHT'] ?? 0) > 0 && !(roomState?.knightUsed ?? false)
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
		const res = await sendAction(action);
		busy = false;
		if (res.ok) setMode('out');
		return res.ok;
	}

	async function nextSpeaker() {
		await run({ kind: 'DayNextSpeaker' });
	}

	async function beginVote() {
		await run({ kind: 'DayBeginVote' });
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

	// The Host taps the seats on the circle (seatPick.svelte.ts).
	$effect(() => {
		if (!isHost || phase === 'LAST_WORDS') return;
		return seatPick.claim({
			pickable: (n) =>
				!busy &&
				livingSeats.some((s) => s.seatNumber === n) &&
				!(mode === 'duel' && duelKnightSeat === n),
			picked: (n) =>
				mode === 'out'
					? outSeats.includes(n)
						? 'wolf'
						: null
					: duelKnightSeat === n
						? 'ember'
						: duelTarget === n
							? 'wolf'
							: null,
			tap: tapSeat
		});
	});

	const pickedLine = $derived.by(() => {
		const picked =
			mode === 'out'
				? [...outSeats].sort((a, b) => a - b)
				: duelKnightSeat === null
					? []
					: [duelKnightSeat, ...(duelTarget === null ? [] : [duelTarget])];
		return picked.length > 0
			? t.nightPrompt.pickedSeats(
					picked.map((n) => seatLabel(n, i18n.lang)).join(mode === 'out' ? '、' : ' ⚔ ')
				)
			: t.nightPrompt.tapSeatAbove;
	});

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
	<!-- The Host's day console sits under the circle with the header already
	     saying which day it is: its question is the title. -->
	{#if !isHost || phase === 'LAST_WORDS'}
		<h3 class="font-display text-lg font-semibold text-ember">
			{phase === 'LAST_WORDS' ? t.discussion.lastWordsTitle : t.discussion.dayTitle}
		</h3>
	{/if}

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
			{dayDecided
				? t.discussion.dayDecided
				: inAppVote
					? t.discussion.playerWaitingVote
					: t.discussion.playerWaiting}
		</p>
	{:else}
		{#if inAppVote && !dayDecided && mode === 'out'}
			<!-- The day's main move with the phone vote on. -->
			<button onclick={beginVote} disabled={busy} class="btn-primary w-full">
				{t.discussion.beginVote}
			</button>
		{/if}
		<p class="font-display text-base font-semibold text-ember">{prompt}</p>
		{#if mode === 'out' && !inAppVote}
			<!-- With the phone vote on, the exile is the vote's; the hint (and its
			     space) would only crowd the circle. -->
			<p class="text-[11px] leading-snug text-zinc-500">{t.discussion.outHint}</p>
		{/if}
		<p class="text-base font-semibold text-bone">{pickedLine}</p>
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

		<!-- The Host's next move once the day is settled: lit then. -->
		<button
			onclick={enterNight}
			disabled={busy}
			class="{markedToday || dayDecided ? 'btn-primary' : 'btn-ghost'} w-full py-2 text-sm"
			>{t.discussion.enterNight}</button
		>
	{/if}
</div>
