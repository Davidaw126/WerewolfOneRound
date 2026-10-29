<script lang="ts">
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { askConfirm } from '$lib/client/confirmDialog.svelte';
	import { PICKABLE_ROLES } from '$lib/shared/roles';
	import { hostVoice } from '$lib/client/hostVoice';
	import { strings, roleName, seatLabel } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';
	import type { RoleId } from '$lib/game/types';

	/** `open` is owned by PhaseBanner, whose top-right button toggles it. */
	let { gameRunning, open }: { gameRunning: boolean; open: boolean } = $props();

	const t = $derived(strings(i18n.lang));
	let seat = $state<number | null>(null);
	let role = $state<RoleId | null>(null);

	const roomState = $derived(gameStore.state);
	const seats = $derived(roomState?.seats.filter((s) => s.sessionId !== null) ?? []);
	// Only this board's roles: a role with no stage tonight would leave the
	// player holding a card the night never calls.
	const boardRoles = $derived(PICKABLE_ROLES.filter((r) => (roomState?.roleConfig?.[r] ?? 0) > 0));

	const voiceSupported = hostVoice.supported;
	/** Manual voice check/unlock - a tap here is itself the gesture iOS wants
	 * before speech may play (normally any tap on the page does it). */
	function testVoice() {
		hostVoice.prime();
		hostVoice.say({ text: t.hostOverride.voiceTestLine, lang: i18n.lang });
	}

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
		<div
			id="host-override-panel"
			class="panel max-h-[50dvh] space-y-3 overflow-y-auto border-ember/30 p-4"
		>
			<p class="text-xs text-zinc-500">{t.hostOverride.warning}</p>

			{#if voiceSupported}
				<button onclick={testVoice} class="btn-ghost w-full py-2 text-xs">
					{t.hostOverride.voiceTest}
				</button>
			{:else}
				<p class="text-xs text-wolf">{t.hostOverride.voiceUnsupported}</p>
			{/if}

			{#if !gameRunning}
				<p class="text-xs text-zinc-500">{t.hostOverride.gameToolsLater}</p>
			{:else}
				<div>
					<p class="mb-1 text-xs text-zinc-400">
						{seat === null ? t.hostOverride.selectPlayer : t.hostOverride.selected(seat)}
					</p>
					<div class="grid grid-cols-4 gap-2">
						{#each seats as s (s.seatNumber)}
							<button
								onclick={() => (seat = seat === s.seatNumber ? null : s.seatNumber)}
								aria-pressed={seat === s.seatNumber}
								class="seat-btn relative {seat === s.seatNumber
									? 'border-ember bg-ember/30 font-bold text-ember ring-2 ring-ember'
									: ''} {s.isDead ? 'opacity-50' : ''}"
							>
								{#if seat === s.seatNumber}
									<span
										class="absolute -top-1.5 -right-1.5 grid h-4 w-4 place-items-center rounded-full bg-ember text-[10px] leading-none text-ink"
										>✓</span
									>
								{/if}
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
		</div>
	{/if}
</div>
