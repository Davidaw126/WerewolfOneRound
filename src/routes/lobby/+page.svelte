<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { sendAction, disconnectSocket } from '$lib/client/socket';
	import { askConfirm } from '$lib/client/confirmDialog.svelte';
	import type { AckResponse } from '$lib/shared/events';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let joinCode = $state('');
	let creating = $state(false);
	let joining = $state(false);
	let loggingOut = $state(false);
	let error = $state<string | null>(null);

	async function logout() {
		if (!(await askConfirm('确定要退出登录吗？需要重新输入用户名才能再次进入。'))) return;
		loggingOut = true;
		await fetch('/logout', { method: 'POST' });
		// The server only ever reads the session cookie once, at the socket's
		// original handshake - without tearing the connection down here, it
		// would keep running under the old (now-deleted) session for the rest
		// of the tab's life, silently misattributing every action after
		// whoever logs in next in this tab.
		disconnectSocket();
		await goto(resolve('/register'));
	}

	async function createRoom() {
		error = null;
		creating = true;
		const res = await sendAction<AckResponse & { roomCode?: string }>({ kind: 'RoomCreate' });
		creating = false;
		if (res.ok && res.roomCode) {
			await goto(resolve('/room/[code]', { code: res.roomCode }));
		} else {
			error = '创建房间失败，请重试';
		}
	}

	async function joinRoom(event: SubmitEvent) {
		event.preventDefault();
		const code = joinCode.trim();
		if (!/^\d{6}$/.test(code)) {
			error = '请输入 6 位房间号';
			return;
		}
		error = null;
		joining = true;
		const res = await sendAction<AckResponse>({ kind: 'RoomJoin', roomCode: code });
		joining = false;
		if (res.ok) {
			await goto(resolve('/room/[code]', { code }));
		} else {
			error = res.ok ? null : res.error === 'room_not_found' ? '房间不存在' : '加入房间失败';
		}
	}
</script>

<svelte:head>
	<title>大厅 · 狼人杀助手</title>
</svelte:head>

<div class="flex min-h-dvh flex-col items-center justify-center px-6 text-zinc-100">
	<div class="w-full max-w-sm">
		<div class="mb-6 text-center">
			<h1 class="title-glow font-display text-5xl font-black tracking-wide text-wolf">狼人杀</h1>
		</div>

		<div class="panel mb-6 flex items-center justify-between px-4 py-3">
			<span class="text-sm font-medium text-zinc-200">{data.username}</span>
			<button onclick={logout} disabled={loggingOut} class="btn-ghost px-3 py-1.5 text-xs">
				{loggingOut ? '退出中…' : '退出登录'}
			</button>
		</div>

		<div class="space-y-4">
			<button onclick={createRoom} disabled={creating} class="btn-primary w-full py-4 text-lg">
				{creating ? '创建中…' : '创建房间'}
			</button>

			<div class="flex items-center gap-3 text-xs text-zinc-600">
				<div class="h-px flex-1 bg-white/10"></div>
				<span>或</span>
				<div class="h-px flex-1 bg-white/10"></div>
			</div>

			<form onsubmit={joinRoom} class="panel p-5">
				<label for="roomCode" class="mb-2 block text-sm font-medium text-zinc-300">加入房间</label>
				<input
					id="roomCode"
					bind:value={joinCode}
					type="text"
					inputmode="numeric"
					maxlength="6"
					placeholder="6 位房间号"
					class="w-full rounded-lg border border-white/10 bg-ink px-4 py-3 text-center text-xl tracking-[0.3em] text-zinc-100 placeholder:text-sm placeholder:tracking-normal placeholder:text-zinc-600 focus:border-ember focus:ring-2 focus:ring-ember/40 focus:outline-none"
				/>
				<button type="submit" disabled={joining} class="btn-ghost mt-4 w-full">
					{joining ? '加入中…' : '加入房间'}
				</button>
			</form>

			{#if error}
				<p class="text-center text-sm text-wolf">{error}</p>
			{/if}
		</div>
	</div>
</div>
