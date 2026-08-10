<script lang="ts">
	// Two independent mutes, sharing the round icon-button style of the other
	// controls in the PhaseBanner cluster (see LeaveRoomButton). Lit in ember
	// when on, so state reads at a glance without decoding the icon.
	import { audioSettings } from '$lib/client/audioSettings.svelte';
	import { strings } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';

	const t = $derived(strings(i18n.lang));

	const btnClass =
		'rounded-full border border-line p-1.5 transition hover:border-wolf/60 hover:text-wolf disabled:cursor-not-allowed disabled:opacity-50';
</script>

<button
	onclick={() => audioSettings.toggleAmbient()}
	aria-label={audioSettings.ambient ? t.audioToggle.musicOn : t.audioToggle.musicOff}
	title={audioSettings.ambient ? t.audioToggle.musicOn : t.audioToggle.musicOff}
	class="{btnClass} {audioSettings.ambient ? 'text-ember' : 'text-zinc-400'}"
>
	<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" class="h-3.5 w-3.5">
		<path stroke-linecap="round" stroke-linejoin="round" d="M7.5 14.5V4.5l8-1.5v10" />
		<circle cx="5.75" cy="14.5" r="1.75" />
		<circle cx="13.75" cy="13" r="1.75" />
		{#if !audioSettings.ambient}
			<path stroke-linecap="round" d="M3.5 3.5 16.5 16.5" />
		{/if}
	</svg>
</button>

<button
	onclick={() => audioSettings.toggleEffects()}
	aria-label={audioSettings.effects ? t.audioToggle.sfxOn : t.audioToggle.sfxOff}
	title={audioSettings.effects ? t.audioToggle.sfxOn : t.audioToggle.sfxOff}
	class="{btnClass} {audioSettings.effects ? 'text-ember' : 'text-zinc-400'}"
>
	<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" class="h-3.5 w-3.5">
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			d="M4 7.5h2.5L10 4.5v11L6.5 12.5H4a.5.5 0 0 1-.5-.5v-4a.5.5 0 0 1 .5-.5Z"
		/>
		{#if audioSettings.effects}
			<path stroke-linecap="round" d="M13 7.5a3.5 3.5 0 0 1 0 5M15.5 5.5a6.5 6.5 0 0 1 0 9" />
		{:else}
			<path stroke-linecap="round" d="M13 7.5 17 12.5M17 7.5 13 12.5" />
		{/if}
	</svg>
</button>
