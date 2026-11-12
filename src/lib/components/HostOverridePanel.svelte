<script lang="ts">
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { askConfirm } from '$lib/client/confirmDialog.svelte';
	import { PICKABLE_ROLES } from '$lib/shared/roles';
	import { strings, roleName } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';
	import type { RoleId } from '$lib/game/types';
	import ScrollArea from './ScrollArea.svelte';
	import { seatPick } from '$lib/client/seatPick.svelte';

	/** `open` is owned by the room page, whose bottom-bar 上帝之手 button
	 * toggles it - the whole flow (open, tap a seat, act, close) stays in the
	 * lower half of the screen. */
	let { gameRunning, open, onClose }: { gameRunning: boolean; open: boolean; onClose: () => void } =
		$props();

	const t = $derived(strings(i18n.lang));
	let seat = $state<number | null>(null);
	let role = $state<RoleId | null>(null);

	const roomState = $derived(gameStore.state);
	const seats = $derived(roomState?.seats.filter((s) => s.sessionId !== null) ?? []);
	// Only this board's roles: a role with no stage tonight would leave the
	// player holding a card the night never calls.
	const boardRoles = $derived(PICKABLE_ROLES.filter((r) => (roomState?.roleConfig?.[r] ?? 0) > 0));

	// While open, the seat is tapped on the circle (seatPick.svelte.ts) -
	// any seated player, the dead too (for 复活).
	$effect(() => {
		if (!open || !gameRunning) return;
		return seatPick.claim({
			pickable: (n) => seats.some((s) => s.seatNumber === n),
			picked: (n) => (seat === n ? 'ember' : null),
			tap: (n) => (seat = seat === n ? null : n)
		});
	});

	async function override(overrideKind: 'KILL' | 'REVIVE' | 'SET_ROLE') {
		if (seat === null) return;
		if (overrideKind === 'SET_ROLE' && !role) return;
		const label = {
			KILL: t.hostOverride.kill,
			REVIVE: t.hostOverride.revive,
			SET_ROLE: t.hostOverride.setRoleTo(role ? roleName(role, i18n.lang) : '')
		}[overrideKind];
		if (!(await askConfirm(t.hostOverride.confirmPrompt(seat, label)))) return;
		await sendAction({
			kind: 'HostOverride',
			overrideKind,
			seat,
			role: overrideKind === 'SET_ROLE' ? (role ?? undefined) : undefined
		});
	}
</script>

<div>
	{#if open}
		<!-- A sheet over the bottom of the screen, not a block in the header:
		     the seat is tapped on the circle, which has to stay in view. -->
		<div
			class="fixed inset-x-0 bottom-0 z-40 mx-auto w-full max-w-lg px-2"
			style="padding-bottom: env(safe-area-inset-bottom)"
		>
			<ScrollArea
				id="host-override-panel"
				class="panel max-h-[50dvh] space-y-3 overflow-y-auto border-ember/60 p-4 shadow-[0_-8px_24px_rgba(0,0,0,0.6)]"
			>
				<p class="text-xs text-zinc-500">{t.hostOverride.warning}</p>

				{#if !gameRunning}
					<p class="text-xs text-zinc-500">{t.hostOverride.gameToolsLater}</p>
				{:else}
					<div>
						<p class="text-base font-semibold text-bone">
							{seat === null ? t.nightPrompt.tapSeatAbove : t.hostOverride.selected(seat)}
						</p>
					</div>
					<div class="flex gap-2">
						<button
							onclick={() => override('KILL')}
							disabled={seat === null}
							class="btn-ghost flex-1 py-2 text-xs"
						>
							💀 {t.hostOverride.kill}
						</button>
						<button
							onclick={() => override('REVIVE')}
							disabled={seat === null}
							class="btn-ghost flex-1 py-2 text-xs"
						>
							✨ {t.hostOverride.revive}
						</button>
					</div>

					<div class="space-y-2">
						<p class="text-xs text-zinc-400">
							{t.hostOverride.changeRoleTo}
							<span class="text-zinc-600">({t.hostOverride.boardRolesOnly})</span>
						</p>
						<select
							bind:value={role}
							class="w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm"
						>
							<option value={null}>{t.hostOverride.selectRolePlaceholder}</option>
							{#each boardRoles as r (r)}
								<option value={r}>{roleName(r, i18n.lang)}</option>
							{/each}
						</select>
						<button
							onclick={() => override('SET_ROLE')}
							disabled={seat === null || !role}
							class="btn-ghost w-full py-2 text-xs"
						>
							{t.hostOverride.confirmChangeRole}
						</button>
					</div>
				{/if}
				<button onclick={onClose} class="btn-ghost w-full py-2 text-sm">
					{t.hostOverride.close}
				</button>
			</ScrollArea>
		</div>
	{/if}
</div>
