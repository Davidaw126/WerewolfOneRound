<script lang="ts">
	// A scrolling region that says so. iPhones hide the scrollbar until a finger
	// is already scrolling, so a list cut off at a clean edge looks finished and
	// people never find what's below it. While there's more below, this shows a
	// fade and a tappable pill at the bottom edge.
	import type { Snippet } from 'svelte';
	import { strings } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';

	let {
		children,
		id,
		class: scrollClass = '',
		wrapClass = ''
	}: {
		children: Snippet;
		id?: string;
		/** Classes for the scrolling element. */
		class?: string;
		/** Classes for the box around it, which the hint is positioned in. */
		wrapClass?: string;
	} = $props();

	// Past the region's own bottom padding: below this, nothing is hidden.
	const HIDDEN_PX = 20;
	const SCROLL_PAGE = 0.8;

	const t = $derived(strings(i18n.lang));
	let scroller = $state<HTMLElement>();
	let moreBelow = $state(false);

	function update() {
		if (!scroller) return;
		moreBelow = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > HIDDEN_PX;
	}

	function scrollDown() {
		scroller?.scrollBy({ top: scroller.clientHeight * SCROLL_PAGE, behavior: 'smooth' });
	}

	// The content changes with the game, and its height with it: a new panel, a
	// seat circle that resizes, a language switch.
	$effect(() => {
		const el = scroller;
		if (!el) return;
		const resized = new ResizeObserver(update);
		const watchSizes = () => {
			resized.disconnect();
			resized.observe(el);
			for (const child of el.children) resized.observe(child);
		};
		const mutated = new MutationObserver(() => {
			watchSizes();
			update();
		});
		mutated.observe(el, { childList: true, subtree: true, characterData: true });
		watchSizes();
		update();
		return () => {
			resized.disconnect();
			mutated.disconnect();
		};
	});
</script>

<div class="relative {wrapClass}">
	<div {id} bind:this={scroller} onscroll={update} class={scrollClass}>
		{@render children()}
	</div>
	{#if moreBelow}
		<div
			class="pointer-events-none absolute inset-x-0 bottom-0 flex h-10 items-end justify-center bg-gradient-to-t from-ink/60 to-transparent pb-1"
		>
			<button
				type="button"
				onclick={scrollDown}
				class="pointer-events-auto border border-ember/50 bg-ink/40 px-2 py-0.5 text-xs font-bold text-ember/80"
			>
				<span class="inline-block">↓</span>
				{t.room.scrollMore}
			</button>
		</div>
	{/if}
</div>
