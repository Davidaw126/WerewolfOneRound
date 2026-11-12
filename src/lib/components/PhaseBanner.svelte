<script lang="ts">
	import { fade } from 'svelte/transition';
	import { phaseGroup } from '$lib/shared/gameTypes';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { askConfirm } from '$lib/client/confirmDialog.svelte';
	import { strings } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';
	import LeaveRoomButton from './LeaveRoomButton.svelte';
	import AudioToggleButtons from './AudioToggleButtons.svelte';
	import HostOverridePanel from './HostOverridePanel.svelte';
	import LanguageToggle from './LanguageToggle.svelte';

	let { username }: { username: string } = $props();
	const isHost = $derived(gameStore.isHost);

	const t = $derived(strings(i18n.lang));
	const room = $derived(gameStore.state);
	let godToolsOpen = $state(false);
	/** The menu sheet: room code, sound, language, name, stop, leave - kept
	 * out of the header so it carries only the phase and 上帝之手. */
	let menuOpen = $state(false);
	const canStop = $derived(
		isHost && room !== null && room.phase !== 'LOBBY' && room.phase !== 'GAME_OVER'
	);

	const label = $derived.by(() => {
		if (!room) return '';
		const n = room.nightNumber;
		switch (phaseGroup(room.phase)) {
			case 'lobby':
				return t.phaseBanner.lobby;
			case 'seating':
				return t.phaseBanner.seating;
			case 'night':
				return t.phaseBanner.night(n);
			case 'speech':
				return room.phase === 'LAST_WORDS'
					? t.phaseBanner.lastWords(n)
					: t.phaseBanner.discussion(n);
			case 'vote':
				return t.phaseBanner.dayVote(n);
			case 'hunter':
				return t.phaseBanner.dayHunter(n);
			case 'over':
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
		switch (room && phaseGroup(room.phase)) {
			case 'night':
				return '🌙';
			case 'speech':
			case 'vote':
			case 'hunter':
				return '☀️';
			default:
				return '';
		}
	});

	async function stopGame() {
		menuOpen = false;
		if (!(await askConfirm(t.phaseBanner.stopGameConfirm))) return;
		await sendAction({ kind: 'RoomStopGame' });
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
					onclick={() => {
						godToolsOpen = !godToolsOpen;
						menuOpen = false;
					}}
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
			<button
				onclick={() => {
					menuOpen = !menuOpen;
					godToolsOpen = false;
				}}
				aria-expanded={menuOpen}
				aria-label={t.phaseBanner.menu}
				title={t.phaseBanner.menu}
				class="shrink-0 rounded-full border px-2.5 py-1.5 text-sm leading-none transition {menuOpen
					? 'border-ember bg-ember/15 text-ember'
					: 'border-line text-zinc-300 hover:border-ember/60 hover:text-ember'}"
			>
				☰
			</button>
		</div>

		<!-- Always there for the host: the voice test is useful before the game
		     too. The panel itself only offers kill/revive/改变身份 once a game
		     is actually running (no cards exist before that). -->
		{#if menuOpen}
			<!-- A sheet over the bottom, like 上帝之手; a tap outside closes it. -->
			<button
				class="fixed inset-0 z-30 cursor-default bg-black/50"
				aria-label={t.phaseBanner.menuClose}
				onclick={() => (menuOpen = false)}
			></button>
			<div
				class="fixed inset-x-0 bottom-0 z-40 mx-auto w-full max-w-lg px-2"
				style="padding-bottom: env(safe-area-inset-bottom)"
			>
				<div
					class="panel space-y-3 border-ember/60 p-4 text-sm shadow-[0_-8px_24px_rgba(0,0,0,0.6)]"
				>
					<div class="flex items-center justify-between gap-2">
						<span class="text-zinc-400">{t.phaseBanner.roomCode}</span>
						<span class="font-display text-lg font-bold tracking-widest text-ember"
							>{room.roomCode}</span
						>
					</div>
					<div class="flex items-center justify-between gap-2">
						<span class="text-zinc-400">{t.phaseBanner.menuName}</span>
						<span class="chip min-w-0 truncate">{username}</span>
					</div>
					<!-- Only the host's phone makes any sound (judge voice + night forest). -->
					{#if isHost}
						<div class="flex items-center justify-between gap-2">
							<span class="text-zinc-400">{t.phaseBanner.menuSound}</span>
							<span class="flex gap-2"><AudioToggleButtons /></span>
						</div>
					{/if}
					<div class="flex items-center justify-between gap-2">
						<span class="text-zinc-400">{t.phaseBanner.menuLanguage}</span>
						<LanguageToggle />
					</div>
					<div class="flex items-center justify-between gap-2">
						<span class="text-zinc-400">{t.phaseBanner.menuLeave}</span>
						<LeaveRoomButton />
					</div>
					{#if canStop}
						<!-- Here, not in the footer: never next to (or read as related
						     to) the phase's own next move. -->
						<button
							onclick={stopGame}
							class="btn-ghost w-full border-wolf/50 py-2 text-sm text-wolf hover:bg-wolf/10"
						>
							■ {t.phaseBanner.stopGameAria}
						</button>
					{/if}
					<button onclick={() => (menuOpen = false)} class="btn-ghost w-full py-2 text-sm">
						{t.phaseBanner.menuClose}
					</button>
				</div>
			</div>
		{/if}

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
