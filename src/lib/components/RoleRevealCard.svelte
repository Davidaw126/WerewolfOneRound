<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import type { AckResponse } from '$lib/shared/events';
	import RoleFace from './RoleFace.svelte';
	import { strings } from '$lib/shared/i18n';
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
			await sendAction<AckResponse>({ kind: 'RevealRole' });
			revealing = false;
			gameStore.logActivity(t.activityLog.youCheckedIdentity);
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
	class="btn-ghost flex min-w-0 flex-1 touch-none flex-wrap items-center justify-center gap-x-2 px-2! py-2 text-xs tracking-normal! [word-break:keep-all] select-none"
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
			<p class="mt-3 text-center text-[11px] text-zinc-500">{t.roleReveal.releaseToHide}</p>
		</div>
	</div>
{/if}
