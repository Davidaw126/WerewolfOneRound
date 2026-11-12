<script lang="ts">
	// The Host's view of tonight: each turn done / on now / still to come, and
	// how long the current one has run - so a turn that has stalled is plain
	// without anyone saying so. Plain text, no motion: the Host's phone sits
	// on the table too. See client/nightPlan.ts for what it's built from.
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { nightPlan } from '$lib/client/nightPlan';
	import { i18n } from '$lib/client/i18n.svelte';
	import { strings, roleName } from '$lib/shared/i18n';

	const t = $derived(strings(i18n.lang));
	const room = $derived(gameStore.state);
	const stage = $derived(gameStore.hostStage);
	const steps = $derived(room ? nightPlan(room.roleConfig ?? {}, room.nightNumber, stage) : []);

	// Seconds on the current turn, counted on this phone from when it heard
	// of the turn.
	const stageKey = $derived(
		stage ? (stage.kind === 'ROLE_TURN' ? stage.role : 'COUPLE_REVEAL') : null
	);
	let seconds = $state(0);
	$effect(() => {
		void stageKey;
		seconds = 0;
		const timer = setInterval(() => (seconds += 1), 1000);
		return () => clearInterval(timer);
	});
	const clock = $derived(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
</script>

{#if steps.length > 0}
	<div class="flex flex-wrap items-center gap-1 text-xs" aria-label={t.room.nightPlan}>
		{#each steps as step, i (i)}
			<span
				class="border px-1.5 py-0.5 {step.status === 'now'
					? 'border-ember text-ember'
					: step.status === 'done'
						? 'border-line text-zinc-600 line-through'
						: 'border-line text-zinc-400'}"
			>
				{step.stage.kind === 'ROLE_TURN' ? roleName(step.stage.role, i18n.lang) : t.gameOver.couple}
			</span>
		{/each}
		{#if stage}
			<span class="ml-auto text-zinc-400 tabular-nums">{clock}</span>
		{/if}
	</div>
{/if}
