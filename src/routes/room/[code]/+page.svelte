<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { getSocket, sendAction } from '$lib/client/socket';
	import { startAmbient, stopAmbient, sfxDeath, narrate } from '$lib/client/sfx';
	import { askConfirm, showAlert } from '$lib/client/confirmDialog.svelte';
	import { leaveConfirmMessage } from '$lib/client/leaveRoom';
	import type { AckResponse } from '$lib/shared/events';
	import type { RoomPublicState } from '$lib/shared/gameTypes';
	import type { PageData } from './$types';
	import SeatCircle from '$lib/components/SeatCircle.svelte';
	import RoleConfigPanel from '$lib/components/RoleConfigPanel.svelte';
	import RoleRevealCard from '$lib/components/RoleRevealCard.svelte';
	import NightActionPrompt from '$lib/components/NightActionPrompt.svelte';
	import VoteBoard from '$lib/components/VoteBoard.svelte';
	import DiscussionPanel from '$lib/components/DiscussionPanel.svelte';
	import HunterShotPrompt from '$lib/components/HunterShotPrompt.svelte';
	import GameOverScreen from '$lib/components/GameOverScreen.svelte';
	import JudgeAudioPlayer from '$lib/components/JudgeAudioPlayer.svelte';
	import PhaseBanner from '$lib/components/PhaseBanner.svelte';
	import DayNightTransition from '$lib/components/DayNightTransition.svelte';
	import ActivityLogButton from '$lib/components/ActivityLogButton.svelte';
	import RoomLogButton from '$lib/components/RoomLogButton.svelte';
	import InfoPopupHost from '$lib/components/InfoPopupHost.svelte';

	let { data }: { data: PageData } = $props();

	// Guards the reconnect-resync handler below from firing on the socket's
	// very first connection, before RoomJoin has told the server which room
	// this session belongs to (that first ResyncRequest would just fail with
	// 'not_in_room' - harmless, but pointless).
	let joined = false;

	function resync() {
		if (!joined) return;
		sendAction<AckResponse & { state?: RoomPublicState }>({ kind: 'ResyncRequest' }).then((res) => {
			if (res.ok && res.state) gameStore.applyState(res.state);
		});
	}

	onMount(() => {
		gameStore.resetForRoomVisit();
		gameStore.connect();
		startAmbient();
		const socket = getSocket();
		// Socket.IO auto-reconnects the transport after any drop (mobile
		// backgrounding, screen lock, a wifi/cellular handoff), and the room
		// channel is silently rejoined server-side on the new connection - but
		// without this, whatever happened during the gap (a vote, a phase
		// change, a death) would just be missing until a full page reload.
		socket.on('connect', resync);

		sendAction<AckResponse & { state?: RoomPublicState }>({
			kind: 'RoomJoin',
			roomCode: data.roomCode
		}).then((res) => {
			if (!res.ok) {
				// Room expired/gone between this page's SSR load and the socket
				// actually joining it - there's nothing to recover into, so bounce
				// back to the lobby instead of leaving the user stuck on "加载中…".
				goto(resolve('/lobby'));
				return;
			}
			joined = true;
			if (res.state) gameStore.applyState(res.state);
			sendAction<AckResponse & { state?: RoomPublicState }>({ kind: 'ResyncRequest' }).then(
				(r2) => {
					if (r2.ok && r2.state) gameStore.applyState(r2.state);
				}
			);
		});
	});
	onDestroy(() => {
		getSocket().off('connect', resync);
		gameStore.disconnect();
		stopAmbient();
	});

	// A death sting whenever a new elimination is announced (night deaths, a day
	// vote-out, or a hunter shot). Tracks the previous values so it fires once
	// per event, not on every reactive re-run.
	let prevNightDeaths: number[] | null = null;
	let prevDaySeat: number | null = null;
	let prevHunterShot: number | null = null;
	$effect(() => {
		const nd = gameStore.lastNightDeaths;
		if (nd !== prevNightDeaths) {
			if (nd && nd.length > 0) sfxDeath();
			prevNightDeaths = nd;
		}
		const ds = gameStore.lastDayResult?.eliminatedSeat ?? null;
		if (ds !== prevDaySeat) {
			if (ds !== null) sfxDeath();
			prevDaySeat = ds;
		}
		const hs = gameStore.lastHunterResult?.shotSeat ?? null;
		if (hs !== prevHunterShot) {
			if (hs !== null) sfxDeath();
			prevHunterShot = hs;
		}
	});

	// The host leaving destroys the room server-side - nothing left here to
	// keep rendering, so bounce everyone still on this page back to /lobby.
	// Shows a blocking alert first (not just the transient toast, which would
	// barely be visible for an instant before the navigation below unmounts
	// this page anyway) so players actually see and register why they were
	// suddenly moved, rather than landing on /lobby with no explanation.
	let roomClosedHandled = false;
	$effect(() => {
		if (gameStore.roomClosed && !roomClosedHandled) {
			roomClosedHandled = true;
			showAlert(gameStore.roomClosedMessage ?? '房间已关闭', '返回大厅').then(() => {
				goto(resolve('/lobby'));
			});
		}
	});

	const roomState = $derived(gameStore.state);
	const mySeat = $derived(
		roomState?.seats.find((s) => s.sessionId === data.sessionId)?.seatNumber ?? null
	);
	const isHost = $derived(
		roomState !== null && roomState !== undefined && roomState.hostSessionId === data.sessionId
	);
	const stage = $derived(roomState?.stage ?? null);
	// S4: only ever meaningful for the host (gated by isHost at the one call
	// site below), so it reads the host-only hostStage (real role) rather than
	// the shared, role-redacted `stage` above.
	const needsHostAdvance = $derived.by(() => {
		const hostStage = gameStore.hostStage;
		return (
			hostStage !== null &&
			(hostStage.kind === 'COUPLE_REVEAL' ||
				(hostStage.kind === 'ROLE_TURN' && hostStage.role === '猎人'))
		);
	});

	// Tints the page toward the game's own day/night rhythm - neutral before a
	// game is underway, since LOBBY/SEATING have no "time of day" of their own.
	const phaseBg = $derived.by(() => {
		switch (roomState?.phase) {
			case 'NIGHT_ACTIONS':
			case 'NIGHT_HUNTER_SHOT':
				return 'from-indigo-950 via-zinc-950 to-black';
			case 'LAST_WORDS':
			case 'DISCUSSION':
			case 'DAY_VOTE':
			case 'DAY_HUNTER_SHOT':
				return 'from-amber-950 via-zinc-950 to-zinc-950';
			case 'GAME_OVER':
				return roomState.winner === 'wolves'
					? 'from-red-950 via-zinc-950 to-black'
					: roomState.winner === 'lovers'
						? 'from-violet-950 via-zinc-950 to-black'
						: 'from-emerald-950 via-zinc-950 to-black';
			default:
				return 'from-zinc-950 via-zinc-900 to-zinc-950';
		}
	});

	async function takeSeat(seatNumber: number) {
		const res = await sendAction<AckResponse>({ kind: 'SeatTake', seatNumber });
		if (!res.ok) {
			gameStore.showToast(
				res.error === 'name_taken' ? '该昵称已被本房间其他玩家使用' : '该座位已被占用'
			);
		}
	}
	async function startGame() {
		await sendAction<AckResponse>({ kind: 'RoomLockSeats', locked: true });
		await sendAction<AckResponse>({ kind: 'RoomStartGame' });
	}
	async function rerollRoles() {
		await sendAction<AckResponse>({ kind: 'RoomRerollRoles' });
	}
	let advancingCoupleReveal = $state(false);

	async function advanceStage() {
		if (stage?.kind === 'COUPLE_REVEAL') {
			// Say the closing cue and hold for the same 3s beat used everywhere
			// else in this app for "let that line land before moving on"
			// (server's POST_ACTION_PAUSE_MS / sfx's NARRATION_GAP_MS) - purely
			// local timing, since only the host's device narrates at all; other
			// players just see the phase change whenever the request lands.
			advancingCoupleReveal = true;
			await new Promise<void>((resolveNarration) => {
				narrate('所有人闭眼', () => setTimeout(resolveNarration, 3000));
			});
			advancingCoupleReveal = false;
		}
		await sendAction<AckResponse>({ kind: 'NightAdvanceStage' });
	}
	async function announceNightResults() {
		await sendAction<AckResponse>({ kind: 'NightAnnounceResults' });
	}

	let leavingAfterGameOver = $state(false);
	let restarting = $state(false);

	async function backToLobby() {
		// GAME_OVER is never one of the in-progress phases (the round has
		// already concluded), so the only thing worth warning about here is
		// the host-destroys-the-room case.
		const { message, confirmLabel } = leaveConfirmMessage(isHost, false);
		if (!(await askConfirm(message, { confirmLabel }))) return;
		leavingAfterGameOver = true;
		// The session still has roomCode set from this finished game - clear
		// it first, or /lobby's own guard will just redirect straight back here.
		await sendAction<AckResponse>({ kind: 'RoomLeave' });
		await goto(resolve('/lobby'));
	}

	async function playAgain() {
		restarting = true;
		// Reset unconditionally, not just on failure - this page never remounts
		// between games in the same room (only the phase changes), so a stale
		// `true` left over from a SUCCESSFUL restart would make the button look
		// permanently stuck the next time GAME_OVER is reached again.
		await sendAction<AckResponse>({ kind: 'RoomStopGame' });
		restarting = false;
	}
</script>

<svelte:head>
	<title>房间 {data.roomCode} · 狼人杀助手</title>
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
		<p class="m-auto text-center text-zinc-500">加载中…</p>
	{:else}
		<!-- Header: pinned, never scrolls - the phase banner and the host's
		     night-results call-to-action stay visible no matter how tall the
		     scrolling content below gets. -->
		<div class="mx-auto w-full max-w-lg shrink-0 space-y-2 px-4 pt-4">
			<PhaseBanner {isHost} username={data.username} />

			{#if isHost && roomState.pendingNightAnnounce}
				<!-- Purely a reveal broadcast, additive to whatever the phase's own
				     content below is showing - dead seats/voting/etc. are never
				     blocked on this, so the host can tap it whenever during the day,
				     not just at one forced moment. -->
				<button onclick={announceNightResults} class="btn-primary w-full"> 公布夜晚结果 </button>
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
			<div
				class="mx-auto flex min-h-0 w-full max-w-lg flex-1 flex-col space-y-4 overflow-y-auto px-4 py-4"
			>
				{#if gameStore.lastNightDeaths !== null}
					<div class="panel px-4 py-2 text-sm text-zinc-400">
						{gameStore.lastNightDeaths.length === 0
							? '昨晚是平安夜'
							: `昨晚 ${gameStore.lastNightDeaths.join('、')} 号玩家死亡`}
					</div>
				{/if}

				{#if gameStore.lastDayResult}
					{@const dayBase = gameStore.lastDayResult.tie
						? '投票平票，无人出局'
						: gameStore.lastDayResult.eliminatedSeat === null
							? '本轮无人出局'
							: `${gameStore.lastDayResult.eliminatedSeat} 号被投票出局，身份是 ${gameStore.lastDayResult.identity}`}
					<div class="panel px-4 py-2 text-sm text-zinc-400">
						{gameStore.lastDayResult.followDeathSeat !== null
							? `${dayBase}，${gameStore.lastDayResult.followDeathSeat} 号殉情身亡`
							: dayBase}
					</div>
				{/if}

				{#if gameStore.lastHunterResult}
					{@const hunterBase =
						gameStore.lastHunterResult.shotSeat === null
							? `${gameStore.lastHunterResult.hunterSeat} 号猎人选择不开枪`
							: `${gameStore.lastHunterResult.hunterSeat} 号猎人开枪带走了 ${gameStore.lastHunterResult.shotSeat} 号`}
					<div class="panel px-4 py-2 text-sm text-zinc-400">
						{gameStore.lastHunterResult.followDeathSeat !== null
							? `${hunterBase}，${gameStore.lastHunterResult.followDeathSeat} 号殉情身亡`
							: hunterBase}
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
					<div class="text-center">
						<p class="text-xs text-zinc-500">分享房间号邀请好友</p>
						<p class="title-glow font-display text-4xl font-black tracking-[0.3em] text-ember">
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
							等待房主 {roomState.hostUsername} 设置房间中…
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
				{:else if roomState.phase === 'NIGHT_ACTIONS'}
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
				{:else if roomState.phase === 'NIGHT_HUNTER_SHOT' || roomState.phase === 'DAY_HUNTER_SHOT'}
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
				{:else if roomState.phase === 'LAST_WORDS' || roomState.phase === 'DISCUSSION'}
					<div class="flex min-h-0 flex-1 flex-col items-center justify-start gap-4">
						<SeatCircle
							seats={roomState.seats}
							{mySeat}
							onTake={() => {}}
							disabled={true}
							hostSessionId={roomState.hostSessionId}
						/>
						<div class="w-full">
							<DiscussionPanel {isHost} />
						</div>
					</div>
				{:else if roomState.phase === 'DAY_VOTE'}
					<div class="flex min-h-0 flex-1 flex-col items-center justify-start gap-4">
						<SeatCircle
							seats={roomState.seats}
							{mySeat}
							onTake={() => {}}
							disabled={true}
							hostSessionId={roomState.hostSessionId}
						/>
						<div class="w-full">
							{#if roomState.pendingNightAnnounce}
								<p class="text-center text-sm text-zinc-500">
									{isHost ? '公布昨晚结果后即可开始投票' : '等待房主公布昨晚结果，投票尚未开始…'}
								</p>
							{:else}
								<VoteBoard {mySeat} {isHost} />
							{/if}
						</div>
					</div>
				{:else if roomState.phase === 'GAME_OVER'}
					<GameOverScreen />
				{/if}
			</div>
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
							<button onclick={rerollRoles} class="btn-ghost flex-1 text-sm">重新分配角色</button>
							<button onclick={startGame} class="btn-primary flex-1">开始游戏</button>
						</div>
					{:else}
						<p class="text-center text-sm text-zinc-500">等待房主开始游戏…</p>
					{/if}
				{:else if roomState.phase === 'GAME_OVER'}
					<div class="flex gap-2">
						{#if isHost}
							<button onclick={playAgain} disabled={restarting} class="btn-primary flex-1">
								{restarting ? '重启中…' : '再来一局'}
							</button>
						{/if}
						<button onclick={backToLobby} disabled={leavingAfterGameOver} class="btn-ghost flex-1">
							{leavingAfterGameOver ? '返回中…' : '返回大厅'}
						</button>
					</div>
				{:else if roomState.phase === 'NIGHT_ACTIONS'}
					<!-- max-h + its own scroll cap: NightActionPrompt's content
					     height varies a lot by role (a single confirm button vs. a
					     full seat-target grid), and this footer doesn't grow the
					     page - without a cap a tall prompt could crowd the seat
					     circle above it out of view instead of just this section
					     scrolling internally. -->
					<div class="max-h-[45vh] space-y-2 overflow-y-auto">
						<NightActionPrompt />
						{#if !gameStore.myTurnRole}
							{#if stage?.kind === 'COUPLE_REVEAL'}
								<!-- Shown to EVERY player during this stage, not just the linked
								     pair - if only the linked two had a button at all, a neighbor
								     glancing at screens could tell who's linked just from which
								     screens have a button, without even seeing its content. -->
								<button
									onclick={() =>
										gameStore.showInfoPopup(
											gameStore.myPartnerSeat !== null
												? `你的情侣是 ${gameStore.myPartnerSeat} 号`
												: '你没有被选为情侣'
										)}
									class="btn-primary w-full"
								>
									查看情侣
								</button>
							{:else}
								<p class="text-center text-sm text-zinc-500">等待其他玩家行动…</p>
							{/if}
						{/if}
						{#if isHost && needsHostAdvance}
							<button
								onclick={advanceStage}
								disabled={advancingCoupleReveal}
								class="btn-ghost w-full hover:bg-ember/10"
							>
								{advancingCoupleReveal ? '闭眼中…' : '继续'}
							</button>
						{/if}
					</div>
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
