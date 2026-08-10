<script lang="ts">
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { askConfirm } from '$lib/client/confirmDialog.svelte';
	import { SUPPORTED_LEGACY_ROLES } from '$lib/game/roleBridge';
	import { strings, roleName, seatLabel } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';
	import type { AckResponse } from '$lib/shared/events';
	import type { Role } from '$lib/shared/roles';

	const t = $derived(strings(i18n.lang));
	let open = $state(false);
	let seat = $state<number | null>(null);
	let role = $state<Role | null>(null);

	const roomState = $derived(gameStore.state);
	const seats = $derived(roomState?.seats.filter((s) => s.sessionId !== null) ?? []);

	async function override(overrideKind: 'KILL' | 'REVIVE' | 'SET_ROLE') {
		if (seat === null) return;
		if (overrideKind === 'SET_ROLE' && !role) return;
		const label = {
			KILL: t.hostOverride.kill,
			REVIVE: t.hostOverride.revive,
			SET_ROLE: t.hostOverride.setRoleTo(role ? roleName(role, i18n.lang) : '')
		}[overrideKind];
		if (!(await askConfirm(t.hostOverride.confirmPrompt(seat, label)))) return;
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
		{t.hostOverride.toggle}
	</button>

	{#if open}
		<div class="panel mt-2 space-y-3 border-ember/30 p-4">
			<p class="text-xs text-zinc-500">{t.hostOverride.warning}</p>

			<div>
				<p class="mb-1 text-xs text-zinc-400">{t.hostOverride.selectPlayer}</p>
				<div class="grid grid-cols-4 gap-2">
					{#each seats as s (s.seatNumber)}
						<button
							onclick={() => (seat = s.seatNumber)}
							class="seat-btn {seat === s.seatNumber ? 'border-ember bg-ember/20 text-ember' : ''}"
						>
							{seatLabel(s.seatNumber, i18n.lang)}
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
				<p class="text-xs text-zinc-400">{t.hostOverride.changeRoleTo}</p>
				<select
					bind:value={role}
					class="w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm"
				>
					<option value={null}>{t.hostOverride.selectRolePlaceholder}</option>
					{#each SUPPORTED_LEGACY_ROLES as r (r)}
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
		</div>
	{/if}
</div>
