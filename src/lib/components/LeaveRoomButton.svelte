<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { sendAction } from '$lib/client/socket';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { askConfirm } from '$lib/client/confirmDialog.svelte';
	import { isGameInProgress, leaveConfirmMessage } from '$lib/client/leaveRoom';
	import { strings } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';
	import type { AckResponse } from '$lib/shared/events';

	let { isHost = false }: { isHost?: boolean } = $props();

	const t = $derived(strings(i18n.lang));
	let leaving = $state(false);

	const gameInProgress = $derived(isGameInProgress(gameStore.state?.phase));

	async function leaveRoom() {
		const { message, confirmLabel } = leaveConfirmMessage(isHost, gameInProgress, i18n.lang);
		if (!(await askConfirm(message, { confirmLabel }))) return;
		leaving = true;
		await sendAction<AckResponse>({ kind: 'RoomLeave' });
		await goto(resolve('/lobby'));
	}
</script>

<button
	onclick={leaveRoom}
	disabled={leaving}
	aria-label={t.leaveRoom.button}
	title={t.leaveRoom.button}
	class="shrink-0 rounded-full border border-line p-1.5 text-zinc-400 transition hover:border-wolf/60 hover:text-wolf disabled:cursor-not-allowed disabled:opacity-50"
>
	{#if leaving}
		<svg viewBox="0 0 20 20" fill="currentColor" class="h-3.5 w-3.5 animate-spin">
			<path d="M10 3a7 7 0 1 0 7 7h-2a5 5 0 1 1-5-5V3Z" opacity="0.9" />
		</svg>
	{:else}
		<svg
			viewBox="0 0 20 20"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			class="h-3.5 w-3.5"
		>
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				d="M8 4H4.5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5H8"
			/>
			<path stroke-linecap="round" stroke-linejoin="round" d="M9 10h7m0 0-2.5-2.5M16 10l-2.5 2.5" />
		</svg>
	{/if}
</button>
