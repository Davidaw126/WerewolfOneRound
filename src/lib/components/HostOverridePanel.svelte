<script lang="ts">
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { askConfirm } from '$lib/client/confirmDialog.svelte';
	import { SUPPORTED_LEGACY_ROLES } from '$lib/game/roleBridge';
	import type { AckResponse } from '$lib/shared/events';
	import type { Role } from '$lib/shared/roles';

	let open = $state(false);
	let seat = $state<number | null>(null);
	let role = $state<Role | null>(null);

	const roomState = $derived(gameStore.state);
	const seats = $derived(roomState?.seats.filter((s) => s.sessionId !== null) ?? []);

	async function override(overrideKind: 'KILL' | 'REVIVE' | 'SET_ROLE') {
		if (seat === null) return;
		if (overrideKind === 'SET_ROLE' && !role) return;
		const label = { KILL: '击杀', REVIVE: '复活', SET_ROLE: `身份改为 ${role}` }[overrideKind];
		if (!(await askConfirm(`确认对 ${seat} 号使用上帝之手：${label}？此操作不可撤销。`))) return;
		await sendAction<AckResponse>({
			kind: 'HostOverride',
			overrideKind,
			seat,
			role: overrideKind === 'SET_ROLE' ? (role ?? undefined) : undefined
		});
	}
</script>

<div>
	<button
		onclick={() => (open = !open)}
		class="rounded-full border border-line px-2 py-1 text-xs text-zinc-400 transition hover:border-ember/60 hover:text-ember"
	>
		🔧 上帝之手
	</button>

	{#if open}
		<div class="panel mt-2 space-y-3 border-ember/30 p-4">
			<p class="text-xs text-zinc-500">仅限特殊情况使用（设备故障等），谨慎操作。</p>

			<div>
				<p class="mb-1 text-xs text-zinc-400">选择玩家：</p>
				<div class="grid grid-cols-4 gap-2">
					{#each seats as s (s.seatNumber)}
						<button
							onclick={() => (seat = s.seatNumber)}
							class="seat-btn {seat === s.seatNumber ? 'border-ember bg-ember/20 text-ember' : ''}"
						>
							{s.seatNumber}号
						</button>
					{/each}
				</div>
			</div>

			<div class="flex gap-2">
				<button
					onclick={() => override('KILL')}
					disabled={seat === null}
					class="btn-ghost flex-1 py-2 text-xs"
				>
					💀 击杀
				</button>
				<button
					onclick={() => override('REVIVE')}
					disabled={seat === null}
					class="btn-ghost flex-1 py-2 text-xs"
				>
					✨ 复活
				</button>
			</div>

			<div class="space-y-2">
				<p class="text-xs text-zinc-400">改变身份为：</p>
				<select
					bind:value={role}
					class="w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm"
				>
					<option value={null}>选择身份…</option>
					{#each SUPPORTED_LEGACY_ROLES as r (r)}
						<option value={r}>{r}</option>
					{/each}
				</select>
				<button
					onclick={() => override('SET_ROLE')}
					disabled={seat === null || !role}
					class="btn-ghost w-full py-2 text-xs"
				>
					🎭 确认改变身份
				</button>
			</div>
		</div>
	{/if}
</div>
