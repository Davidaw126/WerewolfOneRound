<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { line as logLine } from '$lib/client/logLines';
	import RoleFace from './RoleFace.svelte';
	import { strings, seatLabel } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';

	const t = $derived(strings(i18n.lang));

	// S7 身份卡长按才显示，松手立即盖回，切后台立即盖回: no persisted
	// open/closed state at all (unlike the old tap-to-toggle) - the card is
	// visible for exactly as long as the button is actively held, and gone
	// the instant that stops being true, from any cause (release, the
	// pointer sliding off, the tab/app losing focus or being backgrounded).
	let pressing = $state(false);
	let revealing = $state(false);

	const open = $derived(pressing && !!gameStore.myRole);

	async function press() {
		pressing = true;
		if (!gameStore.myRole) {
			revealing = true;
			// Always reset, not just on failure: myRole can later be cleared by a
			// host reroll, which re-renders the unrevealed state - a stale
			// `revealing = true` would otherwise stick as "翻开中…".
			const res = await sendAction({ kind: 'RevealRole' });
			revealing = false;
			if (res.ok) gameStore.logActivity(logLine('text', 'activityLog', 'youCheckedIdentity'));
		}
	}

	function release() {
		pressing = false;
	}

	function handleVisibilityChange() {
		if (document.hidden) pressing = false;
	}
</script>

<!-- Window-level, not just the button's own pointerup/pointerleave: a touch
     that drags off the button, a tab switch, or losing focus entirely must
     all still close the card - relying only on the button's own handlers
     would miss cases where the release/backgrounding happens elsewhere. -->
<svelte:window
	onpointerup={release}
	onpointercancel={release}
	onblur={release}
	onvisibilitychange={handleVisibilityChange}
/>

<button
	onpointerdown={press}
	onkeydown={(e) => {
		if ((e.key === 'Enter' || e.key === ' ') && !pressing) {
			e.preventDefault();
			press();
		}
	}}
	onkeyup={(e) => {
		if (e.key === 'Enter' || e.key === ' ') release();
	}}
	class="btn-ghost btn-bar touch-none select-none"
>
	<span>🎴</span>
	<span>{revealing ? t.roleReveal.revealing : t.roleReveal.holdToView}</span>
</button>

{#if open && gameStore.myRole}
	<div class="overlay-backdrop" role="presentation" transition:fade={{ duration: 100 }}>
		<div
			class="overlay-panel"
			role="dialog"
			aria-modal="true"
			aria-label={t.roleReveal.yourIdentity}
			transition:scale={{ duration: 150, start: 0.85 }}
		>
			<RoleFace role={gameStore.myRole} size="lg" showTeam={false} />
			<!-- What only this player knows about the table, on the same
			     hold-to-view card as the role itself. -->
			{#if gameStore.teammates.length > 0}
				<p class="mt-3 text-center text-sm text-wolf">
					{t.nightPrompt.wolfTeammates(
						gameStore.teammates.map((s) => seatLabel(s, i18n.lang)).join('、')
					)}
				</p>
			{/if}
			{#if gameStore.myPartnerSeat !== null}
				<p class="mt-2 text-center text-sm text-lav">
					💕 {t.room.coupleLinked(gameStore.myPartnerSeat)}
				</p>
			{/if}
			<p class="mt-3 text-center text-[11px] text-zinc-500">{t.roleReveal.releaseToHide}</p>
		</div>
	</div>
{/if}
