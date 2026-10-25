<script lang="ts">
	import { scale } from 'svelte/transition';
	import type { Role } from '$lib/shared/roles';
	import type { SeatState } from '$lib/shared/gameTypes';
	import { strings, roleName } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';
	import PixelSprite from './PixelSprite.svelte';

	let {
		seats,
		mySeat,
		onTake,
		disabled = false,
		hostSessionId = null,
		myTurnRole = null
	}: {
		seats: SeatState[];
		mySeat: number | null;
		onTake: (seat: number) => void;
		disabled?: boolean;
		hostSessionId?: string | null;
		myTurnRole?: Role | null;
	} = $props();

	const seatClass = $derived(
		seats.length > 12
			? 'h-12 w-12 sm:h-14 sm:w-14 text-[9px] sm:text-[10px]'
			: 'h-16 w-16 sm:h-20 sm:w-20 text-[11px] sm:text-sm'
	);

	const t = $derived(strings(i18n.lang));
</script>

<div
	class="relative mx-auto aspect-square w-full max-w-sm rounded-full bg-[radial-gradient(circle,rgba(99,102,241,0.08),rgba(0,0,0,0)_65%)] sm:max-w-md md:max-w-lg"
>
	{#each seats as seat, i (seat.seatNumber)}
		{@const angle = (i / seats.length) * 2 * Math.PI - Math.PI / 2}
		{@const x = 50 + 42 * Math.cos(angle)}
		{@const y = 50 + 42 * Math.sin(angle)}
		{@const isMyTurn = seat.seatNumber === mySeat && myTurnRole !== null}
		<button
			onclick={() => onTake(seat.seatNumber)}
			disabled={disabled || (seat.sessionId !== null && seat.seatNumber !== mySeat)}
			in:scale={{ duration: 240, start: 0.3, delay: i * 25 }}
			style="left:{x}%; top:{y}%"
			class="absolute flex {seatClass} -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center border-[3px] font-medium transition disabled:cursor-not-allowed
				{seat.seatNumber === mySeat
				? 'border-ember bg-ember/20 text-ember'
				: seat.sessionId
					? 'border-line bg-surface-2 text-bone'
					: 'border-dashed border-line bg-surface text-zinc-500 hover:border-ember/60'}
				{seat.isDead ? 'dead-pop opacity-55 grayscale saturate-0' : ''}
				{isMyTurn ? 'animate-pulse shadow-[0_0_0_4px_rgba(245,158,11,0.4)]' : ''}"
		>
			{#if seat.sessionId === hostSessionId}
				<span class="absolute -top-1.5 -right-1 text-[10px]" title={t.seatCircle.host}>👑</span>
			{/if}
			{#if seat.revealedIdiot && !seat.isDead}
				<span
					class="pointer-events-none absolute -bottom-1.5 rounded-sm border border-line bg-surface px-1 text-[8px] text-zinc-300"
				>
					{roleName('白痴', i18n.lang)}
				</span>
			{/if}
			{#if seat.isDead}
				<span
					in:scale={{ duration: 300, start: 0.3 }}
					class="pointer-events-none absolute inset-0 flex items-center justify-center text-lg opacity-90"
					aria-label={t.seatCircle.dead}
				>
					💀
				</span>
			{/if}
			<span
				class="absolute -top-1.5 -left-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-line bg-surface text-[8px] text-zinc-500 sm:h-4 sm:w-4"
			>
				{seat.seatNumber}
			</span>
			{#key seat.sessionId}
				<span
					class="line-clamp-2 max-w-full px-1 text-center leading-tight break-words"
					in:scale={{ duration: 200, start: 0.6 }}
				>
					{seat.username ?? t.seatCircle.empty}
				</span>
			{/key}
		</button>
	{/each}
	<div
		class="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-25"
	>
		<PixelSprite role="普通狼人" px={56} idle={false} />
	</div>
</div>

<style>
	/* Deaths "land": a one-shot shake when a seat first becomes dead. */
	.dead-pop {
		animation: deathpop 0.4s steps(3) 1;
	}
	@keyframes deathpop {
		0% {
			transform: translate(-50%, -50%) rotate(0);
		}
		25% {
			transform: translate(-54%, -48%) rotate(-8deg);
		}
		75% {
			transform: translate(-46%, -52%) rotate(8deg);
		}
		100% {
			transform: translate(-50%, -50%) rotate(-6deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.dead-pop {
			animation: none;
		}
	}
</style>
