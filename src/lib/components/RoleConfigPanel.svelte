<script lang="ts">
	import { fly } from 'svelte/transition';
	import { ALL_ROLES, roleTeam, type Role } from '$lib/shared/roles';
	import { sendAction } from '$lib/client/socket';
	import type { AckResponse } from '$lib/shared/events';
	import PixelSprite from './PixelSprite.svelte';

	let counts = $state<Record<Role, number>>(
		Object.fromEntries(ALL_ROLES.map((r) => [r, 0])) as Record<Role, number>
	);
	let cupidPoisonBlocksHunter = $state(false);
	let submitting = $state(false);
	let error = $state<string | null>(null);

	const goodRoles = ALL_ROLES.filter((r) => roleTeam(r) === 'village');
	const wolfRoles = ALL_ROLES.filter((r) => roleTeam(r) === 'wolf');

	const total = $derived(Object.values(counts).reduce((s: number, n) => s + (n ?? 0), 0));
	const goodTotal = $derived(goodRoles.reduce((s, r) => s + (counts[r] ?? 0), 0));
	const wolfTotal = $derived(wolfRoles.reduce((s, r) => s + (counts[r] ?? 0), 0));

	function inc(role: Role, delta: number) {
		counts[role] = Math.max(0, (counts[role] ?? 0) + delta);
	}

	async function submit() {
		error = null;
		if (total === 0) {
			error = '请至少配置一个角色';
			return;
		}
		submitting = true;
		const res = await sendAction<AckResponse>({
			kind: 'RoomSubmitConfig',
			roleConfig: counts,
			cupidPoisonBlocksHunter
		});
		submitting = false;
		if (!res.ok) error = '配置提交失败，请重试';
	}
</script>

{#snippet section(title: string, subtitle: string, roles: Role[], count: number, good: boolean)}
	<div class="panel p-3">
		<div
			class="mb-3 flex items-center justify-between border-[3px] border-line px-2 py-1.5 text-xs font-bold tracking-widest uppercase {good
				? 'bg-village text-black'
				: 'bg-wolf-deep text-bone'}"
		>
			<span>{good ? '☀' : '☾'} {title} · {subtitle}</span>
			<span class="tabular-nums">{count}</span>
		</div>
		<div class="grid grid-cols-2 gap-2">
			{#each roles as role, i (role)}
				<div
					in:fly={{ y: 10, duration: 200, delay: i * 25 }}
					class="flex items-center gap-2 border-[3px] border-line p-1.5 {(counts[role] ?? 0) > 0
						? 'bg-surface-2'
						: 'bg-surface'}"
				>
					<PixelSprite {role} px={30} idle={(counts[role] ?? 0) > 0} />
					<div class="min-w-0 flex-1">
						<div class="truncate text-[11px] text-bone">{role}</div>
					</div>
					<div class="flex items-center gap-1">
						<button
							onclick={() => inc(role, -1)}
							aria-label="减少"
							class="h-6 w-6 border-2 border-line bg-line text-bone active:bg-ember active:text-black"
							>−</button
						>
						<span class="w-4 text-center text-sm text-village tabular-nums"
							>{counts[role] ?? 0}</span
						>
						<button
							onclick={() => inc(role, 1)}
							aria-label="增加"
							class="h-6 w-6 border-2 border-line bg-line text-bone active:bg-ember active:text-black"
							>+</button
						>
					</div>
				</div>
			{/each}
		</div>
	</div>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col space-y-3">
	<h2 class="font-display text-lg font-semibold tracking-wider text-ember uppercase">角色配置</h2>

	<div class="min-h-0 flex-1 space-y-3 overflow-y-auto">
		{@render section('好人阵营', 'Village', goodRoles, goodTotal, true)}
		{@render section('狼人阵营', 'Wolves', wolfRoles, wolfTotal, false)}

		<div class="panel p-3">
			<div class="mb-2 text-xs font-bold tracking-widest text-ember uppercase">
				规则 · House Rule
			</div>
			<button
				type="button"
				onclick={() => (cupidPoisonBlocksHunter = !cupidPoisonBlocksHunter)}
				class="flex w-full items-center gap-3 border-[3px] border-line p-2 text-left {cupidPoisonBlocksHunter
					? 'bg-surface-2'
					: 'bg-surface'}"
			>
				<span
					class="flex h-6 w-6 flex-none items-center justify-center border-2 border-line text-sm {cupidPoisonBlocksHunter
						? 'bg-ember text-black'
						: 'bg-line text-transparent'}">✓</span
				>
				<span class="text-[11px] leading-snug text-bone">
					情侣殉情算中毒 · 猎人被毒死的情侣因殉情死亡时，也不能开枪
				</span>
			</button>
		</div>
	</div>

	<!-- The role list above is flex-1 (fills all leftover space itself, with
	     its own internal scroll), so this just naturally lands at the true
	     bottom as a normal shrink-0 flex item - no mt-auto/sticky needed, and
	     no big empty gap either since the list absorbs the slack instead of
	     leaving it blank. Border-t + bg-ink/95 matches the page's own pinned
	     footer styling elsewhere in the room. -->
	<div class="shrink-0 space-y-2 border-t-[3px] border-line bg-ink/95 px-1 py-2">
		<p class="text-sm text-zinc-500">
			共 {total} 张牌{(counts['盗贼'] ?? 0) > 0 ? `（含盗贼，实际 ${total - 2} 个座位）` : ''}
		</p>
		{#if error}<p class="text-sm text-wolf">{error}</p>{/if}
		<button onclick={submit} disabled={submitting} class="btn-primary w-full">
			{submitting ? '提交中…' : '确认配置'}
		</button>
	</div>
</div>
