<script lang="ts">
	import { fade } from 'svelte/transition';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { askConfirm } from '$lib/client/confirmDialog.svelte';
	import type { AckResponse } from '$lib/shared/events';
	import LeaveRoomButton from './LeaveRoomButton.svelte';
	import AudioToggleButtons from './AudioToggleButtons.svelte';

	let { isHost, username }: { isHost: boolean; username: string } = $props();

	const state = $derived(gameStore.state);
	const canStop = $derived(
		isHost && state !== null && state.phase !== 'LOBBY' && state.phase !== 'GAME_OVER'
	);

	const label = $derived.by(() => {
		if (!state) return '';
		switch (state.phase) {
			case 'LOBBY':
				return '房主配置角色中';
			case 'SEATING':
				return '玩家入座中';
			case 'NIGHT_ACTIONS':
				return `第 ${state.nightNumber} 夜`;
			case 'NIGHT_HUNTER_SHOT':
				return `第 ${state.nightNumber} 夜 · 猎人开枪`;
			case 'DAY_VOTE':
				return `第 ${state.nightNumber} 天 · 投票`;
			case 'DAY_HUNTER_SHOT':
				return `第 ${state.nightNumber} 天 · 猎人开枪`;
			case 'GAME_OVER':
				return '游戏结束';
		}
	});

	const stageLabel = $derived.by(() => {
		const stage = state?.stage;
		if (!stage) return null;
		return stage.kind === 'COUPLE_REVEAL' ? '情侣确认身份' : `${stage.role} 行动中`;
	});

	const timeGlyph = $derived.by(() => {
		switch (state?.phase) {
			case 'NIGHT_ACTIONS':
			case 'NIGHT_HUNTER_SHOT':
				return '🌙';
			case 'DAY_VOTE':
			case 'DAY_HUNTER_SHOT':
				return '☀️';
			default:
				return '';
		}
	});

	async function stopGame() {
		if (!(await askConfirm('确定要结束当前游戏吗？所有玩家将返回座位，可使用相同配置重新开始。')))
			return;
		await sendAction<AckResponse>({ kind: 'RoomStopGame' });
	}
</script>

{#if state}
	<div class="panel flex flex-wrap items-center justify-between gap-2 px-4 py-3">
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
		<div class="flex flex-wrap items-center gap-2">
			<div class="chip">{username}</div>
			<div class="chip">房间号 {state.roomCode}</div>
			<AudioToggleButtons />
			{#if canStop}
				<!-- A small, tucked-away header control - deliberately not a full-width
				     button in the main content flow, so it never sits next to (or
				     reads as related to) whatever the primary phase action button is
				     (公布夜晚结果/开始游戏/继续/etc). -->
				<button
					onclick={stopGame}
					aria-label="结束游戏"
					title="结束游戏"
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
{/if}
