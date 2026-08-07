<script lang="ts">
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { askConfirm } from '$lib/client/confirmDialog.svelte';
	import type { AckResponse } from '$lib/shared/events';

	let { isHost }: { isHost: boolean } = $props();

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
		if (!(await askConfirm(`确认 ${explodeSeat} 号自爆身份为狼人？此操作不可撤销。`))) return;
		const res = await sendAction<AckResponse>({ kind: 'DaySelfExplode', seat: explodeSeat });
		if (res.ok) {
			explodeOpen = false;
			explodeSeat = null;
		}
	}

	async function confirmDuel() {
		if (duelKnightSeat === null || duelTargetSeat === null) return;
		if (
			!(await askConfirm(
				`确认 ${duelKnightSeat} 号（骑士）与 ${duelTargetSeat} 号决斗？此操作不可撤销。`
			))
		)
			return;
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
		{phase === 'LAST_WORDS' ? '遗言' : '发言'}
	</h3>

	{#if speaker}
		<p class="text-center text-sm text-zinc-300">
			当前发言：<span class="font-semibold text-ember"
				>{speaker.seatNumber} 号 {speaker.username}</span
			>
		</p>
	{:else}
		<p class="text-center text-sm text-zinc-500">
			{phase === 'LAST_WORDS' ? '遗言已结束' : '发言顺序已结束'}
		</p>
	{/if}

	{#if isHost}
		<button onclick={nextSpeaker} class="btn-ghost w-full py-2 text-sm">下一位</button>

		{#if phase === 'DISCUSSION'}
			<button onclick={beginVote} class="btn-primary w-full">开始投票</button>

			<div class="space-y-2 border-t border-white/10 pt-3">
				{#if !explodeOpen && !duelOpen}
					<div class="flex gap-2">
						<button onclick={() => (explodeOpen = true)} class="btn-ghost flex-1 py-2 text-xs">
							💥 有玩家自爆
						</button>
						<button onclick={() => (duelOpen = true)} class="btn-ghost flex-1 py-2 text-xs">
							⚔️ 骑士决斗
						</button>
					</div>
				{/if}

				{#if explodeOpen}
					<div class="space-y-2">
						<p class="text-xs text-zinc-400">选择自爆玩家：</p>
						<div class="grid grid-cols-4 gap-2">
							{#each livingSeats as seat (seat.seatNumber)}
								<button
									onclick={() => (explodeSeat = seat.seatNumber)}
									class="seat-btn {explodeSeat === seat.seatNumber
										? 'border-wolf bg-wolf/20 text-wolf'
										: ''}"
								>
									{seat.seatNumber}号
								</button>
							{/each}
						</div>
						<div class="flex gap-2">
							<button
								onclick={confirmExplode}
								disabled={explodeSeat === null}
								class="btn-primary flex-1 py-2 text-sm">确认</button
							>
							<button
								onclick={() => {
									explodeOpen = false;
									explodeSeat = null;
								}}
								class="btn-ghost flex-1 py-2 text-sm">取消</button
							>
						</div>
					</div>
				{/if}

				{#if duelOpen}
					<div class="space-y-2">
						<p class="text-xs text-zinc-400">选择骑士：</p>
						<div class="grid grid-cols-4 gap-2">
							{#each livingSeats as seat (seat.seatNumber)}
								<button
									onclick={() => (duelKnightSeat = seat.seatNumber)}
									class="seat-btn {duelKnightSeat === seat.seatNumber
										? 'border-ember bg-ember/20 text-ember'
										: ''}"
								>
									{seat.seatNumber}号
								</button>
							{/each}
						</div>
						<p class="text-xs text-zinc-400">选择被决斗者：</p>
						<div class="grid grid-cols-4 gap-2">
							{#each livingSeats as seat (seat.seatNumber)}
								<button
									onclick={() => (duelTargetSeat = seat.seatNumber)}
									disabled={seat.seatNumber === duelKnightSeat}
									class="seat-btn {duelTargetSeat === seat.seatNumber
										? 'border-wolf bg-wolf/20 text-wolf'
										: ''}"
								>
									{seat.seatNumber}号
								</button>
							{/each}
						</div>
						<div class="flex gap-2">
							<button
								onclick={confirmDuel}
								disabled={duelKnightSeat === null || duelTargetSeat === null}
								class="btn-primary flex-1 py-2 text-sm">确认</button
							>
							<button
								onclick={() => {
									duelOpen = false;
									duelKnightSeat = null;
									duelTargetSeat = null;
								}}
								class="btn-ghost flex-1 py-2 text-sm">取消</button
							>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	{:else}
		<p class="text-center text-xs text-zinc-500">等待房主推进…</p>
	{/if}
</div>
