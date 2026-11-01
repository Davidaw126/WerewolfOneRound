<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import type { ClientAction } from '$lib/shared/events';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { roomSession } from '$lib/client/roomSession.svelte';
	import { askConfirm, showAlert } from '$lib/client/confirmDialog.svelte';
	import { leaveConfirmMessage } from '$lib/client/leaveRoom';
	import { i18n } from '$lib/client/i18n.svelte';
	import { strings, formatNightDeaths, formatDayResult, outMessage } from '$lib/shared/i18n';
	import { phaseGroup } from '$lib/shared/gameTypes';
	import type { PageData } from './$types';
	import SeatCircle from '$lib/components/SeatCircle.svelte';
	import RoleConfigPanel from '$lib/components/RoleConfigPanel.svelte';
	import RoleRevealCard from '$lib/components/RoleRevealCard.svelte';
	import NightActionPrompt from '$lib/components/NightActionPrompt.svelte';
	import VoteBoard from '$lib/components/VoteBoard.svelte';
	import DiscussionPanel from '$lib/components/DiscussionPanel.svelte';
	import HunterShotPrompt from '$lib/components/HunterShotPrompt.svelte';
	import GameOverScreen from '$lib/components/GameOverScreen.svelte';
	import DawnSelfExplode from '$lib/components/DawnSelfExplode.svelte';
	import JudgeAudioPlayer from '$lib/components/JudgeAudioPlayer.svelte';
	import { keepScreenAwake } from '$lib/client/wakeLock';
	import PhaseBanner from '$lib/components/PhaseBanner.svelte';
	import DayNightTransition from '$lib/components/DayNightTransition.svelte';
	import ActivityLogButton from '$lib/components/ActivityLogButton.svelte';
	import RoomLogButton from '$lib/components/RoomLogButton.svelte';
	import InfoPopupHost from '$lib/components/InfoPopupHost.svelte';
	import ScrollArea from '$lib/components/ScrollArea.svelte';

	let { data }: { data: PageData } = $props();

	const t = $derived(strings(i18n.lang));

	onMount(() => {
		releaseWakeLock = keepScreenAwake();
		// The lobby usually entered the room already; a reload or a shared
		// link enters here. A room that's gone by now: back to the lobby.
		roomSession.open(data.roomCode, data.sessionId).then((inRoom) => {
			if (!inRoom) goto(resolve('/lobby'));
		});
	});
	let releaseWakeLock: (() => void) | null = null;
	onDestroy(() => {
		releaseWakeLock?.();
		roomSession.close();
	});

	// Out of the room (it closed, this player left on another phone, or the
	// server no longer has them in it): a blocking alert first, so the move
	// back to the lobby never comes without a reason.
	$effect(() => {
		const reason = roomSession.out;
		if (!reason) return;
		showAlert(outMessage(reason, i18n.lang), t.room.backToLobby).then(() =>
			goto(resolve('/lobby'))
		);
	});

	const roomState = $derived(gameStore.state);
	const group = $derived(roomState ? phaseGroup(roomState.phase) : null);
	const mySeat = $derived(gameStore.mySeat);
	const isHost = $derived(gameStore.isHost);
	const stage = $derived(roomState?.stage ?? null);
	// Tints the page toward the game's own day/night rhythm.
	const PHASE_BG = {
		neutral: 'from-zinc-950 via-zinc-900 to-zinc-950',
		night: 'from-indigo-950 via-zinc-950 to-black',
		day: 'from-amber-950 via-zinc-950 to-zinc-950',
		wolves: 'from-red-950 via-zinc-950 to-black',
		lovers: 'from-violet-950 via-zinc-950 to-black',
		villagers: 'from-emerald-950 via-zinc-950 to-black'
	} as const;
	const phaseBg = $derived(PHASE_BG[gameStore.timeOfDay]);

	async function takeSeat(seatNumber: number) {
		// A failure (seat taken, name clash) pops up via the global handler.
		await sendAction({ kind: 'SeatTake', seatNumber });
	}
	async function startGame() {
		// One step on the server: locks the seats, checks the setup against
		// who sat down, and deals - or refuses with the seats left open.
		await hostAction({ kind: 'RoomStartGame' });
	}
	async function rerollRoles() {
		await hostAction({ kind: 'RoomRerollRoles' });
	}
	// One at a time: a second tap while the first is on its way would re-deal
	// everyone again, or get a Start or 公布 refused with an error popup.
	let hostBusy = $state(false);
	async function hostAction(action: ClientAction) {
		if (hostBusy) return;
		hostBusy = true;
		await sendAction(action);
		hostBusy = false;
	}
	/** Fallback only - players act or confirm for themselves; this is for a
	 * turn stuck on a phone that died or locked. The host's eyes are shut too. The closing cue is
	 * JudgeAudioPlayer's, on the stage change, however it happens. */
	async function advanceStage() {
		if (!(await askConfirm(t.room.confirmForceContinue))) return;
		await sendAction({ kind: 'NightAdvanceStage' });
	}

	async function confirmCouple() {
		const res = await sendAction({ kind: 'NightConfirmStage' });
		if (res.ok) gameStore.coupleConfirmed = true;
	}
	async function announceNightResults() {
		await hostAction({ kind: 'NightAnnounceResults' });
	}

	async function enterNightNow() {
		if (!(await askConfirm(t.discussion.confirmEnterNightPlain))) return;
		await hostAction({ kind: 'DayEndDay' });
	}

	let leavingAfterGameOver = $state(false);
	let restarting = $state(false);

	async function backToLobby() {
		// GAME_OVER is never one of the in-progress phases (the round has
		// already concluded), so the only thing worth warning about here is
		// the host-destroys-the-room case.
		const { message, confirmLabel } = leaveConfirmMessage(isHost, false, i18n.lang);
		if (!(await askConfirm(message, { confirmLabel }))) return;
		leavingAfterGameOver = true;
		// The session still has roomCode set from this finished game - clear
		// it first, or /lobby's own guard will just redirect straight back here.
		await roomSession.leave();
		await goto(resolve('/lobby'));
	}

	async function playAgain() {
		restarting = true;
		// Reset unconditionally, not just on failure - this page never remounts
		// between games in the same room (only the phase changes), so a stale
		// `true` left over from a SUCCESSFUL restart would make the button look
		// permanently stuck the next time GAME_OVER is reached again.
		await sendAction({ kind: 'RoomStopGame' });
		restarting = false;
	}
</script>

<svelte:head>
	<title
		>{i18n.lang === 'zh'
			? `房间 ${data.roomCode} · 狼人杀助手`
			: `Room ${data.roomCode} · Werewolf`}</title
	>
</svelte:head>

{#if isHost}
	<!-- Narration only ever plays on the room owner's device - other players'
	     devices would otherwise all announce the same cues in an overlapping
	     chorus, which makes no sense once there's one physical "judge" phone. -->
	<JudgeAudioPlayer />
{/if}

<DayNightTransition />
<InfoPopupHost />

<div
	class="flex h-dvh flex-col overflow-hidden bg-gradient-to-b {phaseBg} text-zinc-100 transition-colors duration-700"
>
	{#if !roomState}
		<p class="m-auto text-center text-zinc-500">{t.room.loading}</p>
	{:else}
		<!-- Header: pinned, never scrolls - the phase banner and the host's
		     night-results call-to-action stay visible no matter how tall the
		     scrolling content below gets. -->
		<div class="mx-auto w-full max-w-lg shrink-0 space-y-2 px-4 pt-4">
			<PhaseBanner username={data.username} />

			{#if isHost && gameStore.awaitingNightAnnounce}
				<!-- Purely a reveal broadcast, additive to whatever the phase's own
				     content below is showing - dead seats/voting/etc. are never
				     blocked on this, so the host can tap it whenever during the day,
				     not just at one forced moment. -->
				<button onclick={announceNightResults} disabled={hostBusy} class="btn-primary w-full">
					{t.room.announceButton}
				</button>
				<DawnSelfExplode />
			{:else if isHost && roomState?.phase === 'DISCUSSION' && roomState.dayDecided}
				<!-- The day is settled, so this is the Host's one next move: pinned
				     here rather than below the seats, off-screen at a big table. -->
				<button onclick={enterNightNow} disabled={hostBusy} class="btn-primary w-full">
					{t.discussion.enterNight}
				</button>
			{/if}
		</div>

		<!-- Middle: the only region that scrolls - everything else (header,
		     footer) is fixed to the viewport, so the page itself never scrolls.
		     Both this div and its child are flex columns (flex-1 chained
		     through, not percentage heights) so the child is reliably at least
		     as tall as the visible scroll area even when its content is short -
		     percentage heights (min-h-full) need every single ancestor to
		     explicitly resolve a definite height, which is easy to silently
		     break; flex-grow doesn't have that fragility. overflow-y-auto lives
		     on the INNER max-w-lg column, not this outer full-width one - on a
		     wide viewport (tablet, desktop browser) the content column is
		     narrower than the screen, and a scrollbar on the outer div would
		     render flush against the screen's edge, visibly detached from the
		     column it's actually scrolling. -->
		<div class="flex min-h-0 flex-1 flex-col">
			<ScrollArea
				wrapClass="mx-auto flex min-h-0 w-full max-w-lg flex-1 flex-col"
				class="flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto px-4 py-4"
			>
				{#if gameStore.state?.lastNightDeaths}
					<div class="panel px-4 py-2 text-sm text-zinc-400">
						{formatNightDeaths(gameStore.state.lastNightDeaths, i18n.lang)}
					</div>
				{/if}

				{#if gameStore.state?.lastDayResult}
					<div class="panel px-4 py-2 text-sm text-zinc-400">
						{formatDayResult({ ...gameStore.state.lastDayResult, lang: i18n.lang })}
					</div>
				{/if}

				{#if gameStore.toast}
					<div class="panel border-wolf/40 px-4 py-2 text-sm text-wolf">
						{gameStore.toast}
					</div>
				{/if}

				{#if gameStore.confirmToast}
					<div class="panel border-village/40 px-4 py-2 text-sm text-village">
						{gameStore.confirmToast}
					</div>
				{/if}

				{#if roomState.phase === 'LOBBY'}
					<div class="flex items-center justify-center gap-3">
						<p class="text-xs text-zinc-500">{t.room.shareCode}</p>
						<p
							class="selectable title-glow font-display text-2xl font-black tracking-[0.2em] text-ember"
						>
							{data.roomCode}
						</p>
					</div>
					{#if isHost}
						<!-- hostSessionId is assigned at RoomCreate time (see
						     createRoom), not to whoever submits config first - so
						     this is reliably the room's actual creator. min-h-0
						     flex-1 gives RoleConfigPanel a real height to fill so
						     its own confirm button can stay pinned at the bottom. -->
						<div class="flex min-h-0 flex-1 flex-col">
							<RoleConfigPanel />
						</div>
					{:else}
						<p class="text-center text-sm text-zinc-500">
							{t.room.waitingHostConfig(roomState.hostUsername ?? '')}
						</p>
					{/if}
				{:else if roomState.phase === 'SEATING'}
					<!-- Anchored to the top (not vertically centered) of whatever
					     space is left after the room-code/result blocks above it -
					     centering here would let an oversized seat circle overflow
					     symmetrically and bleed its top edge up into those blocks
					     whenever a banner (e.g. 昨晚X号死亡) shrinks the space below. -->
					<div class="flex min-h-0 flex-1 items-start justify-center">
						<SeatCircle
							seats={roomState.seats}
							{mySeat}
							onTake={takeSeat}
							disabled={roomState.lockStatus}
							hostSessionId={roomState.hostSessionId}
						/>
					</div>
				{:else if group === 'night'}
					<!-- Same top-anchored treatment as SEATING - the action prompt
					     itself now lives in the pinned footer below (see there),
					     so the circle stays fully visible instead of sharing this
					     space with whatever the prompt's own content height is. -->
					<div class="flex min-h-0 flex-1 items-start justify-center">
						<SeatCircle
							seats={roomState.seats}
							{mySeat}
							onTake={() => {}}
							disabled={true}
							hostSessionId={roomState.hostSessionId}
							myTurnRole={gameStore.myTurnRole}
						/>
					</div>
				{:else if group === 'hunter'}
					<div class="flex min-h-0 flex-1 flex-col items-center justify-start gap-4">
						<SeatCircle
							seats={roomState.seats}
							{mySeat}
							onTake={() => {}}
							disabled={true}
							hostSessionId={roomState.hostSessionId}
						/>
						<div class="w-full">
							<HunterShotPrompt />
						</div>
					</div>
				{:else if group === 'speech'}
					<div class="flex min-h-0 flex-1 flex-col items-center justify-start gap-4">
						<SeatCircle
							seats={roomState.seats}
							{mySeat}
							onTake={() => {}}
							disabled={true}
							hostSessionId={roomState.hostSessionId}
						/>
						<div class="w-full">
							<DiscussionPanel />
						</div>
					</div>
				{:else if group === 'vote'}
					<div class="flex min-h-0 flex-1 flex-col items-center justify-start gap-4">
						<SeatCircle
							seats={roomState.seats}
							{mySeat}
							onTake={() => {}}
							disabled={true}
							hostSessionId={roomState.hostSessionId}
						/>
						<div class="w-full">
							{#if gameStore.awaitingNightAnnounce}
								<p class="text-center text-sm text-zinc-500">
									{isHost ? t.room.voteWaitAnnounceHost : t.room.voteWaitAnnouncePlayer}
								</p>
							{:else}
								<VoteBoard />
							{/if}
						</div>
					</div>
				{:else if roomState.phase === 'GAME_OVER'}
					<GameOverScreen />
				{/if}
			</ScrollArea>
		</div>

		{#if roomState.phase !== 'LOBBY'}
			<!-- Footer: pinned bottom toolbar, always reachable without scrolling -
			     not position:fixed (avoids mobile Safari's fixed-position/virtual-
			     keyboard quirks), just the last flex child in a shell that never
			     scrolls itself. Hidden entirely during LOBBY (role config) - there's
			     no game to log/reveal yet. No backdrop-blur here: backdrop-filter on
			     an ancestor creates a new containing block for position:fixed
			     descendants, which broke ActivityLogButton/RoomLogButton/
			     RoleRevealCard's overlay dialogs (they'd center within this footer
			     strip instead of the full screen) - bg-ink/95 gives the same visual
			     separation without that hazard. -->
			<div
				class="mx-auto w-full max-w-lg shrink-0 space-y-2 border-t-[3px] border-line bg-ink/95 px-4 py-2"
				style="padding-bottom: max(0.5rem, env(safe-area-inset-bottom))"
			>
				{#if roomState.phase === 'SEATING'}
					{#if isHost}
						<div class="flex gap-2">
							<button onclick={rerollRoles} disabled={hostBusy} class="btn-ghost flex-1 text-sm"
								>{t.room.reroll}</button
							>
							<button onclick={startGame} disabled={hostBusy} class="btn-primary flex-1"
								>{t.room.startGame}</button
							>
						</div>
					{:else}
						<p class="text-center text-sm text-zinc-500">{t.room.seatingWaitingHost}</p>
					{/if}
				{:else if roomState.phase === 'GAME_OVER'}
					<div class="flex gap-2">
						{#if isHost}
							<button onclick={playAgain} disabled={restarting} class="btn-primary flex-1">
								{restarting ? t.room.restarting : t.room.playAgain}
							</button>
						{/if}
						<button onclick={backToLobby} disabled={leavingAfterGameOver} class="btn-ghost flex-1">
							{leavingAfterGameOver ? t.room.leavingBack : t.room.backToLobby}
						</button>
					</div>
				{:else if group === 'night'}
					<!-- max-h + its own scroll cap: NightActionPrompt's content
					     height varies a lot by role (a single confirm button vs. a
					     full seat-target grid), and this footer doesn't grow the
					     page - without a cap a tall prompt could crowd the seat
					     circle above it out of view instead of just this section
					     scrolling internally. -->
					<ScrollArea class="max-h-[45vh] space-y-2 overflow-y-auto">
						<NightActionPrompt />
						{#if !gameStore.myTurnRole}
							{#if stage?.kind === 'COUPLE_REVEAL'}
								<!-- Shown to EVERY player during this stage, not just the linked
								     pair - if only the linked two had a button at all, a neighbor
								     glancing at screens could tell who's linked just from which
								     screens have a button, without even seeing its content. -->
								{#if gameStore.coupleConfirmed}
									<p class="text-center text-sm text-zinc-500">{t.room.stageConfirmedWait}</p>
								{:else}
									<button
										onclick={() =>
											gameStore.showInfoPopup(
												gameStore.myPartnerSeat !== null
													? t.room.coupleLinked(gameStore.myPartnerSeat)
													: t.room.coupleNotLinked
											)}
										class="btn-primary w-full"
									>
										{t.room.viewCouple}
									</button>
									<!-- The lovers move the night on themselves once both have
									     tapped; on every other phone it's the same button doing
									     nothing, so screens can't give the couple away. -->
									<button onclick={confirmCouple} class="btn-ghost w-full">
										{t.room.coupleConfirm}
									</button>
								{/if}
							{:else}
								<p class="text-center text-sm text-zinc-500">{t.room.waitingOthers}</p>
							{/if}
						{/if}
						{#if gameStore.needsHostAdvance}
							<button
								onclick={advanceStage}
								class="btn-ghost w-full py-1.5 text-xs text-zinc-500 hover:bg-ember/10"
							>
								{t.room.forceContinue}
							</button>
						{/if}
					</ScrollArea>
				{/if}
				<div class="flex gap-2">
					<ActivityLogButton />
					<RoomLogButton />
					{#if mySeat !== null && roomState.phase !== 'GAME_OVER'}
						<RoleRevealCard />
					{/if}
				</div>
			</div>
		{/if}
	{/if}
</div>
