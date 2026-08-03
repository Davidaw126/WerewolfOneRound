<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import type { AckResponse } from '$lib/shared/events';
	import RoleFace from './RoleFace.svelte';
	import { sfxReveal } from '$lib/client/sfx';

	let revealing = $state(false);
	// Purely local, client-side - the server already knows this session has
	// revealed (so a page refresh still replays the role), but hiding it again
	// here needs no round-trip: closing the overlay keeps a neighbor from
	// glancing at it, without forgetting what the role was.
	let hidden = $state(false);

	// Overlay is open only when a role is known AND not locally hidden.
	const open = $derived(!!gameStore.myRole && !hidden);

	async function handleTap() {
		if (!gameStore.myRole) {
			revealing = true;
			// Always reset, not just on failure: myRole can later be cleared by a
			// host reroll, which re-renders the unrevealed state - a stale
			// `revealing = true` would otherwise stick as "翻开中…".
			await sendAction<AckResponse>({ kind: 'RevealRole' });
			revealing = false;
			sfxReveal();
			gameStore.logActivity('你查看了自己的身份');
		} else {
			hidden = !hidden;
		}
	}

	function close() {
		hidden = true;
	}

	// Whenever there's no revealed role (fresh room, host reroll), keep `hidden`
	// reset - otherwise the NEXT reveal could open straight into hidden state.
	$effect(() => {
		if (gameStore.myRole === null) hidden = false;
	});
</script>

<button
	onclick={handleTap}
	class="btn-ghost flex flex-1 items-center justify-center gap-2 py-2 text-xs"
>
	<span>🎴</span>
	<span>{revealing ? '翻开中…' : '查看身份'}</span>
</button>

{#if open && gameStore.myRole}
	<div
		class="overlay-backdrop"
		role="presentation"
		onclick={close}
		transition:fade={{ duration: 150 }}
	>
		<div
			class="overlay-panel"
			role="dialog"
			aria-modal="true"
			aria-label="你的身份"
			transition:scale={{ duration: 200, start: 0.85 }}
		>
			<RoleFace role={gameStore.myRole} size="lg" showTeam={false} />
			<button onclick={close} class="btn-primary mt-4 w-full">隐藏身份</button>
		</div>
	</div>
{/if}
