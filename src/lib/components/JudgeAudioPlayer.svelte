<script lang="ts">
	// The Host phone's narration: what to say comes from narrationCues.ts as
	// the game changes, and hostVoice.ts says it. Mounted only on the Host's
	// phone - one voice for the table, not a chorus.
	import { onMount } from 'svelte';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { hostVoice } from '$lib/client/hostVoice';
	import { cuesFor, QUIET, type Cue, type VoiceView } from '$lib/client/narrationCues';
	import { sendAction } from '$lib/client/socket';
	import { i18n } from '$lib/client/i18n.svelte';
	import { strings } from '$lib/shared/i18n';

	let before: VoiceView = QUIET;

	function run(cue: Cue) {
		if (cue.kind === 'stop') return hostVoice.stop();
		if (cue.kind === 'drop') return hostVoice.drop(cue.tag);
		const role = cue.relay;
		hostVoice.say({
			text: cue.text,
			lang: i18n.lang,
			tag: cue.tag,
			onStart: role
				? () => void sendAction({ kind: 'NightNarrationStarted', role }, { quiet: true })
				: undefined
		});
	}

	onMount(() => {
		// A phone that stops speaking asks the Host for one tap, which
		// unlocks it again.
		hostVoice.onBlocked(() =>
			gameStore.showInfoPopup(strings(i18n.lang).narration.voiceBlocked, 'bad', 8000)
		);
		return () => {
			hostVoice.onBlocked(null);
			hostVoice.stop();
		};
	});

	$effect(() => {
		const now: VoiceView = {
			phase: gameStore.state?.phase ?? null,
			awaitingNightAnnounce: gameStore.awaitingNightAnnounce,
			hostStage: gameStore.hostStage,
			nightDeaths: gameStore.lastNightDeaths,
			dayResult: gameStore.lastDayResult,
			gameOver: gameStore.gameOverResult
		};
		for (const cue of cuesFor(before, now, i18n.lang)) run(cue);
		before = now;
	});
</script>

<!-- No 点击开启语音播报 banner: any tap anywhere unlocks the voice (the root
     layout), and the Host has tapped plenty by nightfall. The manual
     test/unlock lives in 上帝之手 (HostOverridePanel) for the odd case, e.g.
     a refresh mid-night. -->
