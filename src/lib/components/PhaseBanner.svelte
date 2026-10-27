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

	let { username }: { username: string } = $props();
	const isHost = $derived(gameStore.isHost);

	const t = $derived(strings(i18n.lang));
	const room = $derived(gameStore.state);
	let godToolsOpen = $state(false);
	const canStop = $derived(
		isHost && room !== null && room.phase !== 'LOBBY' && room.phase !== 'GAME_OVER'
	);

	const label = $derived.by(() => {
		if (!room) return '';
		const n = room.nightNumber;
		switch (room.phase) {
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
		const stage = room?.stage;
		if (!stage) return null;
		return stage.kind === 'COUPLE_REVEAL'
			? t.phaseBanner.stageCoupleConfirm
			: t.phaseBanner.stageActing;
	});

	const timeGlyph = $derived.by(() => {
		switch (room?.phase) {
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

{#if room}
	<div class="panel space-y-1.5 px-3 py-2">
		<!-- Hero row: the phase status is the one thing that actually changes
		     what you need to do next, so it gets the full width to itself
		     instead of competing for space with the utility controls below. -->
		<div class="flex items-center gap-2">
			{#if timeGlyph}
				<span class="text-lg">{timeGlyph}</span>
			{/if}
			<div class="min-w-0 flex-1">
				{#key room.phase}
					<div in:fade={{ duration: 250 }} class="font-display text-sm font-semibold text-ember">
						{label}
					</div>
				{/key}
				{#if stageLabel}
					<div class="text-xs text-zinc-500">{stageLabel}</div>
				{/if}
			</div>
			{#if isHost}
				<!-- Top-right, out of the way of the phase actions; while open it
				     turns ember and says 收起 so it reads as the way to close it. -->
				<button
					onclick={() => (godToolsOpen = !godToolsOpen)}
					aria-expanded={godToolsOpen}
					aria-controls="host-override-panel"
					class="shrink-0 rounded-full border px-3 py-1.5 text-xs whitespace-nowrap transition {godToolsOpen
						? 'border-ember bg-ember/15 text-ember'
						: 'border-line text-zinc-400 hover:border-ember/60 hover:text-ember'}"
				>
					{#if godToolsOpen}
						🔧 {t.hostOverride.close} ▲
					{:else}
						{t.hostOverride.toggle} ▾
					{/if}
				</button>
			{/if}
		</div>

		<!-- Utility strip: room/audio (static, room-wide) on the left,
		     identity + destructive controls on the right. One row at any width:
		     the username chip is the only part that gives way (truncates), so
		     nothing gets pushed off the edge and the bar stays short. -->
		<div class="flex items-center gap-2">
			<div class="flex shrink-0 items-center gap-2">
				<div
					class="chip whitespace-nowrap"
					title={t.phaseBanner.roomCode}
					aria-label="{t.phaseBanner.roomCode} {room.roomCode}"
				>
					#{room.roomCode}
				</div>
				<!-- Only the host's phone makes any sound (judge voice + night forest). -->
				{#if isHost}
					<AudioToggleButtons />
				{/if}
				<LanguageToggle />
			</div>
			<div class="ml-auto flex min-w-0 items-center justify-end gap-2">
				<!-- Mid-game the host's strip also carries the stop button; on the
				     narrowest phones there's no room left for a readable name. -->
				<div class="chip min-w-0 truncate {canStop ? 'max-[359px]:hidden' : ''}">{username}</div>
				{#if canStop}
					<!-- A small, tucked-away header control - deliberately not a full-width
					     button in the main content flow, so it never sits next to (or
					     reads as related to) whatever the primary phase action button is
					     (公布夜晚结果/开始游戏/继续/etc). -->
					<button
						onclick={stopGame}
						aria-label={t.phaseBanner.stopGameAria}
						title={t.phaseBanner.stopGameAria}
						class="shrink-0 rounded-full border border-wolf/40 p-1.5 text-wolf transition hover:border-wolf/70 hover:bg-wolf/10"
					>
						<svg viewBox="0 0 20 20" fill="currentColor" class="h-3.5 w-3.5">
							<rect x="5" y="5" width="10" height="10" rx="1.5" />
						</svg>
					</button>
				{/if}
				<LeaveRoomButton />
			</div>
		</div>

		<!-- Always there for the host: the voice test is useful before the game
		     too. The panel itself only offers kill/revive/改变身份 once a game
		     is actually running (no cards exist before that). -->
		{#if isHost}
			<HostOverridePanel
				open={godToolsOpen}
				gameRunning={room.phase !== 'LOBBY' &&
					room.phase !== 'SEATING' &&
					room.phase !== 'GAME_OVER'}
			/>
		{/if}
	</div>
{/if}
