<script lang="ts">
	import { scale } from 'svelte/transition';
	import type { SeatState } from '$lib/shared/gameTypes';
	import { strings, roleName } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';
	import { seatPick } from '$lib/client/seatPick.svelte';
	import PixelSprite from './PixelSprite.svelte';

	let {
		seats,
		mySeat,
		onTake = () => {},
		disabled = false,
		highlight = [],
		fit = false
	}: {
		seats: SeatState[];
		mySeat: number | null;
		/** Seating only: a tap takes the seat. */
		onTake?: (seat: number) => void;
		disabled?: boolean;
		/** Seats the latest news is about (last night's dead, today's exits). */
		highlight?: number[];
		/** Shrink to the height left too, not only the width - for the night,
		 * where the prompt below takes what it needs. Needs a parent with
		 * `container-type: size`. */
		fit?: boolean;
	} = $props();

	// The table speaks in numbers, so the number is the seat's main label and
	// the name sits under it.
	const big = $derived(seats.length > 12);
	// Sized from the circle (cqw), so a circle shrunk to fit keeps its seats
	// from overlapping.
	const seatSize = $derived(big ? 14 : 18.5);
	const numberSize = $derived(big ? 'clamp(13px, 5cqw, 22px)' : 'clamp(15px, 6.5cqw, 28px)');

	/** A panel picking on the circle (seatPick.svelte.ts), if any. */
	const picking = $derived(seatPick.current);

	const t = $derived(strings(i18n.lang));
</script>

<div
	style={fit ? 'width: min(100cqw, 100cqh)' : ''}
	class="relative mx-auto aspect-square {fit
		? ''
		: 'w-full'} [container-type:inline-size] max-w-sm rounded-full bg-[radial-gradient(circle,rgba(99,102,241,0.08),rgba(0,0,0,0)_65%)] sm:max-w-md md:max-w-lg"
>
	{#each seats as seat, i (seat.seatNumber)}
		{@const angle = (i / seats.length) * 2 * Math.PI - Math.PI / 2}
		{@const x = 50 + 42 * Math.cos(angle)}
		{@const y = 50 + 42 * Math.sin(angle)}
		{@const canPick = picking?.pickable(seat.seatNumber) ?? false}
		{@const tone = picking?.picked(seat.seatNumber) ?? null}
		{@const inNews = highlight.includes(seat.seatNumber)}
		<button
			onclick={() =>
				picking
					? (canPick || tone !== null) && picking.tap(seat.seatNumber)
					: onTake(seat.seatNumber)}
			disabled={picking
				? !canPick && tone === null
				: disabled || (seat.sessionId !== null && seat.seatNumber !== mySeat)}
			aria-pressed={picking ? tone !== null : undefined}
			in:scale={{ duration: 240, start: 0.3, delay: i * 25 }}
			style="left:{x}%; top:{y}%; width:{seatSize}cqw; height:{seatSize}cqw"
			class="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center border-[3px] transition disabled:cursor-not-allowed
				{tone === 'wolf'
				? 'border-wolf bg-wolf/25 text-wolf'
				: tone === 'ember'
					? 'border-ember bg-ember/25 text-ember'
					: seat.seatNumber === mySeat
						? 'border-ember bg-ember/20 text-ember'
						: seat.sessionId
							? 'border-line bg-surface-2 text-bone'
							: 'border-dashed border-line bg-surface text-zinc-500 hover:border-ember/60'}
				{picking && canPick && tone === null ? 'border-bone/70' : ''}
				{picking && !canPick && tone === null ? 'opacity-35' : ''}
				{seat.isDead && !inNews ? 'dead-pop opacity-55 grayscale saturate-0' : ''}
				{seat.isDead && inNews ? 'dead-pop opacity-80' : ''}
				{inNews ? 'shadow-[0_0_0_3px_rgba(220,38,38,0.85)]' : ''}
"
		>
			{#if seat.seatNumber === mySeat}
				<!-- Which seat is yours, at a glance. Static, like everything on
				     the circle (see the quiet-screens rule). -->
				<span
					class="pointer-events-none absolute -top-2.5 -right-2 border-2 border-ink bg-ember px-1 text-[11px] leading-tight font-bold text-black"
				>
					{t.seatCircle.me}
				</span>
			{/if}
			{#if tone !== null}
				<span
					class="absolute -top-2 -left-1.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-line text-xs {tone ===
					'wolf'
						? 'bg-wolf text-bone'
						: 'bg-ember text-black'}"
				>
					✓
				</span>
			{/if}
			{#if seat.revealedIdiot && !seat.isDead}
				<span
					class="pointer-events-none absolute -bottom-2 rounded-sm border border-line bg-surface px-1 text-[11px] text-zinc-300"
				>
					{roleName('IDIOT', i18n.lang)}
				</span>
			{/if}
			{#if seat.isDead}
				<span
					in:scale={{ duration: 300, start: 0.3 }}
					class="pointer-events-none absolute -right-1.5 -bottom-2 text-base"
					aria-label={t.seatCircle.dead}
				>
					💀
				</span>
			{/if}
			<span class="font-display leading-none font-bold" style="font-size:{numberSize}"
				>{seat.seatNumber}</span
			>
			{#key seat.sessionId}
				<span
					class="mt-0.5 block max-w-full truncate px-1 text-center text-[11px] leading-tight {seat.sessionId
						? 'opacity-80'
						: ''}"
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
		<PixelSprite role="WEREWOLF" px={56} idle={false} />
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
