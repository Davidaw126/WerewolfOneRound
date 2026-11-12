<script lang="ts">
	import { renderLine, renderRound } from '$lib/client/logLines';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { i18n } from '$lib/client/i18n.svelte';
	import ScrollArea from '$lib/components/ScrollArea.svelte';
	import { strings, formatGameOverText, roleName } from '$lib/shared/i18n';
	import { roleTeam } from '$lib/shared/roles';
	import PixelSprite from './PixelSprite.svelte';

	const t = $derived(strings(i18n.lang));
	const result = $derived(gameStore.gameOverView);
	const seats = $derived(gameStore.state?.seats ?? []);
	// §11.4 enriched GAME_OVER screen - the room log already narrates every
	// public event (deaths, votes, hunter shots, self-explodes, overrides)
	// through the whole game; surfacing it here means nobody has to dig for
	// "房间动态" separately right when it matters most.
	const timeline = $derived(gameStore.roomLog);

	// One row per seat, the wolves together and the good side together, each
	// marked alive or out - the table checks the reveal against what it saw.
	const camps = $derived.by(() => {
		if (!result) return [];
		const seated = seats.filter((s) => s.sessionId !== null || result.identities[s.seatNumber]);
		const wolves = seated.filter((s) => {
			const r = result.identities[s.seatNumber];
			return r && roleTeam(r) === 'wolf';
		});
		const good = seated.filter((s) => !wolves.includes(s));
		return [
			{ wolf: true, title: t.roleConfig.wolfCamp, seats: wolves },
			{ wolf: false, title: t.roleConfig.goodCamp, seats: good }
		];
	});
</script>

{#if result}
	<div class="space-y-5 text-center">
		<h2
			class="font-display text-4xl font-black {result.winner === 'wolves'
				? 'title-glow text-wolf'
				: result.winner === 'lovers'
					? 'text-lav'
					: 'text-village'}"
			style={result.winner === 'wolves'
				? ''
				: result.winner === 'lovers'
					? 'text-shadow:0 0 24px rgba(184,161,255,0.45)'
					: 'text-shadow:0 0 24px rgba(232,195,122,0.45)'}
		>
			{formatGameOverText(result.winner, i18n.lang, false)}
		</h2>

		{#each camps as camp (camp.wolf)}
			<div class="space-y-1.5 text-left">
				<div
					class="flex items-center justify-between border-[3px] border-line px-2 py-1 text-xs font-bold tracking-widest {camp.wolf
						? 'bg-wolf-deep text-bone'
						: 'bg-village text-black'}"
				>
					<span>{camp.wolf ? '☾' : '☀'} {camp.title}</span>
					<span class="tabular-nums">{camp.seats.length}</span>
				</div>
				{#each camp.seats as seat (seat.seatNumber)}
					{@const role = result.identities[seat.seatNumber]}
					{@const isCouple = result.coupleSeats?.includes(seat.seatNumber) ?? false}
					<div
						class="flex items-center gap-3 border-2 border-line bg-surface-2 px-2 py-1.5 {seat.isDead
							? 'opacity-60'
							: ''}"
					>
						<span class="w-7 text-center font-display text-xl font-bold text-bone tabular-nums"
							>{seat.seatNumber}</span
						>
						{#if role}<PixelSprite {role} px={28} idle={false} />{/if}
						<div class="min-w-0 flex-1">
							<div
								class="truncate text-sm font-semibold {camp.wolf ? 'text-wolf' : 'text-village'}"
							>
								{role ? roleName(role, i18n.lang) : t.gameOver.unknownRole}
								{#if isCouple}<span title={t.gameOver.couple}>💕</span>{/if}
							</div>
							<div class="truncate text-xs text-zinc-400">{seat.username ?? ''}</div>
						</div>
						<span
							class="shrink-0 border px-1.5 py-0.5 text-xs {seat.isDead
								? 'border-line text-zinc-400'
								: 'border-village/60 text-village'}"
						>
							{seat.isDead ? `💀 ${t.seatCircle.dead}` : t.gameOver.alive}
						</span>
					</div>
				{/each}
			</div>
		{/each}

		{#if timeline.length > 0}
			<div class="space-y-2 text-left">
				<h3 class="font-display text-sm font-bold tracking-widest text-ember uppercase">
					{t.gameOver.timeline}
				</h3>
				<ScrollArea class="max-h-[40dvh] space-y-2 overflow-y-auto">
					{#each timeline as entry, i (i)}
						<div class="border-2 border-line bg-surface-2 px-3 py-2 text-xs">
							<div class="mb-1 text-ember">{renderRound(entry.round, i18n.lang)}</div>
							<div class="text-bone">{renderLine(entry.line, i18n.lang)}</div>
						</div>
					{/each}
				</ScrollArea>
			</div>
		{/if}
	</div>
{/if}
