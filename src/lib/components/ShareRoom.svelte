<script lang="ts">
	// Inviting the table: the room code, a link that lands a new player in
	// this room once they've picked a name, and that link as a QR code.
	import qrcode from 'qrcode-generator';
	import { fade, scale } from 'svelte/transition';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { roomPath } from '$lib/shared/roomLink';
	import { strings } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';

	let { code }: { code: string } = $props();

	const t = $derived(strings(i18n.lang).room);
	let open = $state(false);
	const link = $derived(`${location.origin}${roomPath(code)}`);

	/** The QR code as one SVG path of unit squares - no image, no request. */
	const qr = $derived.by(() => {
		const grid = qrcode(0, 'M');
		grid.addData(link);
		grid.make();
		const size = grid.getModuleCount();
		let path = '';
		for (let row = 0; row < size; row++)
			for (let col = 0; col < size; col++)
				if (grid.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
		return { size, path };
	});

	async function share() {
		try {
			if (navigator.share) {
				await navigator.share({ url: link });
				return;
			}
			await navigator.clipboard.writeText(link);
			gameStore.showConfirm(t.linkCopied);
		} catch {
			// The share sheet was dismissed, or copying isn't allowed here: the
			// code and the QR code are still on screen.
		}
	}
</script>

<div class="flex items-center justify-center gap-3">
	<p class="selectable title-glow font-display text-2xl font-black tracking-[0.2em] text-ember">
		{code}
	</p>
	<button onclick={() => (open = true)} class="btn-ghost px-3 py-1.5 text-sm">{t.invite}</button>
</div>

{#if open}
	<div
		class="overlay-backdrop"
		role="presentation"
		onclick={() => (open = false)}
		transition:fade={{ duration: 150 }}
	>
		<div
			class="overlay-panel panel space-y-4 p-5 text-center"
			role="dialog"
			aria-modal="true"
			aria-label={t.invite}
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			transition:scale={{ duration: 200, start: 0.85 }}
		>
			<p class="text-sm text-zinc-400">{t.scanToJoin}</p>
			<svg
				viewBox="-2 -2 {qr.size + 4} {qr.size + 4}"
				class="mx-auto w-56 max-w-full bg-white"
				role="img"
				aria-label={link}
				shape-rendering="crispEdges"
			>
				<path d={qr.path} fill="#000" />
			</svg>
			<p class="selectable font-display text-3xl font-black tracking-[0.2em] text-ember">{code}</p>
			<button onclick={share} class="btn-primary w-full">{t.shareLink}</button>
			<button onclick={() => (open = false)} class="btn-ghost w-full">{t.closeInvite}</button>
		</div>
	</div>
{/if}
