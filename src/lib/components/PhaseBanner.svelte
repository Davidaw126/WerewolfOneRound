<script lang="ts">
	import { fade } from 'svelte/transition';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { askConfirm } from '$lib/client/confirmDialog.svelte';
	import { strings } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';
	import type { AckResponse } from '$lib/shared/events';
	import LeaveRoomButton from './LeaveRoomButton.svelte';
	import AudioToggleButtons from './AudioToggleButtons.svelte';
	import HostOverridePanel from './HostOverridePanel.svelte';
	import LanguageToggle from './LanguageToggle.svelte';

	let { isHost, username }: { isHost: boolean; username: string } = $props();

	const t = $derived(strings(i18n.lang));
	const state = $derived(gameStore.state);
	const canStop = $derived(
		isHost && state !== null && state.phase !== 'LOBBY' && state.phase !== 'GAME_OVER'
	);

	const label = $derived.by(() => {
		if (!state) return '';
		const n = state.nightNumber;
		switch (state.phase) {
			case 'LOBBY':
				return t.phaseBanner.lobby;
			case 'SEATING':
				return t.phaseBanner.seating;
			case 'NIGHT_ACTIONS':
				return t.phaseBanner.night(n);
			case 'NIGHT_HUNTER_SHOT':
				return t.phaseBanner.nightHunter(n);
			case 'LAST_WORDS':
				return t.phaseBanner.lastWords(n);
			case 'DISCUSSION':
				return t.phaseBanner.discussion(n);
			case 'DAY_VOTE':
				return t.phaseBanner.dayVote(n);
			case 'DAY_HUNTER_SHOT':
				return t.phaseBanner.dayHunter(n);
			case 'GAME_OVER':
				return t.phaseBanner.gameOver;
		}
	});

	// S4: `stage` is the room-wide (role-redacted) form - deliberately never
	// names which role is acting here, only that some role's turn is underway.
	const stageLabel = $derived.by(() => {
		const stage = state?.stage;
		if (!stage) return null;
		return stage.kind === 'COUPLE_REVEAL'
			? t.phaseBanner.stageCoupleConfirm
			: t.phaseBanner.stageActing;
	});

	const timeGlyph = $derived.by(() => {
		switch (state?.phase) {
			case 'NIGHT_ACTIONS':
			case 'NIGHT_HUNTER_SHOT':
				return '🌙';
			case 'LAST_WORDS':
			case 'DISCUSSION':
			case 'DAY_VOTE':
			case 'DAY_HUNTER_SHOT':
				return '☀️';
			default:
				return '';
		}
	});

	async function stopGame() {
		if (!(await askConfirm(t.phaseBanner.stopGameConfirm))) return;
		await sendAction<AckResponse>({ kind: 'RoomStopGame' });
	}
</script>

{#if state}
	<div class="panel space-y-1.5 px-4 py-2.5">
		<!-- Hero row: the phase status is the one thing that actually changes
		     what you need to do next, so it gets the full width to itself
		     instead of competing for space with the utility controls below. -->
		<div class="flex items-center gap-2">
			{#if timeGlyph}
				<span class="text-lg">{timeGlyph}</span>
			{/if}
			<div>
				{#key state.phase}
					<div in:fade={{ duration: 250 }} class="font-display text-sm font-semibold text-ember">
						{label}
					</div>
				{/key}
				{#if stageLabel}
					<div class="text-xs text-zinc-500">{stageLabel}</div>
				{/if}
			</div>
		</div>

		<!-- Utility strip: room/audio (static, room-wide) on the left,
		     identity + destructive controls on the right. -->
		<div class="flex items-center justify-between gap-2">
			<div class="flex items-center gap-2">
				<div class="chip">{t.phaseBanner.roomCode} {state.roomCode}</div>
				<!-- Only the host's phone makes any sound (judge voice + night forest). -->
				{#if isHost}
					<AudioToggleButtons />
				{/if}
				<LanguageToggle />
			</div>
			<div class="flex items-center gap-2">
				<div class="chip">{username}</div>
				{#if canStop}
					<!-- A small, tucked-away header control - deliberately not a full-width
					     button in the main content flow, so it never sits next to (or
					     reads as related to) whatever the primary phase action button is
					     (公布夜晚结果/开始游戏/继续/etc). -->
					<button
						onclick={stopGame}
						aria-label={t.phaseBanner.stopGameAria}
						title={t.phaseBanner.stopGameAria}
						class="rounded-full border border-wolf/40 p-1.5 text-wolf transition hover:border-wolf/70 hover:bg-wolf/10"
					>
						<svg viewBox="0 0 20 20" fill="currentColor" class="h-3.5 w-3.5">
							<rect x="5" y="5" width="10" height="10" rx="1.5" />
						</svg>
					</button>
				{/if}
				<LeaveRoomButton {isHost} />
			</div>
		</div>

		<!-- Always there for the host: the voice test is useful before the game
		     too. The panel itself only offers kill/revive/改变身份 once a game
		     is actually running (no cards exist before that). -->
		{#if isHost}
			<HostOverridePanel
				gameRunning={state.phase !== 'LOBBY' &&
					state.phase !== 'SEATING' &&
					state.phase !== 'GAME_OVER'}
			/>
		{/if}
	</div>
{/if}
