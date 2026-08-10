<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { narrate, stopNarration } from '$lib/client/sfx';
	import { sendAction } from '$lib/client/socket';
	import { i18n } from '$lib/client/i18n.svelte';
	import {
		strings,
		formatNightDeaths,
		formatDayResult,
		formatHunterResult,
		formatGameOverText,
		type Strings
	} from '$lib/shared/i18n';
	import type { Role } from '$lib/shared/roles';

	let unlocked = $state(false);
	let lastPhase: string | null = null;
	let lastStageKey: string | null = null;
	let lastNightDeaths: number[] | null = null;
	let lastDayResult: unknown = null;
	let lastHunterResult: unknown = null;
	let lastGameOver: unknown = null;
	let lastPendingNightAnnounce = false;

	const t = $derived(strings(i18n.lang).narration);

	// Moderator-style call-outs, one per role with a night action.
	const roleLineKeys: Partial<Record<Role, keyof Strings['narration']>> = {
		普通狼人: 'wolfTurn',
		预言家: 'seerTurn',
		女巫: 'witchTurn',
		守卫: 'guardTurn',
		狼美人: 'wolfBeautyTurn',
		丘比特: 'cupidTurn',
		盗贼: 'thiefTurn',
		猎人: 'hunterTurn'
	};

	function unlockAudio() {
		unlocked = true;
		// Some browsers only allow speechSynthesis to actually produce audio
		// after a real user gesture - a near-silent utterance here "unlocks"
		// the pipeline the same way the old silent-clip trick did.
		narrate(' ', i18n.lang);
	}

	onMount(() => {
		// Piggyback on whatever the player naturally taps first on this page
		// (their seat, a config control, the start button) instead of a
		// dedicated "enable sound" prompt - by the time NIGHT_ACTIONS begins
		// they've long since tapped something, so narration just starts with
		// no separate visible step.
		document.addEventListener('pointerdown', unlockAudio, { capture: true, once: true });
		return () => document.removeEventListener('pointerdown', unlockAudio, { capture: true });
	});
	onDestroy(() => {
		stopNarration();
	});

	function say(text: string, onStart?: () => void) {
		if (!unlocked) {
			// Audio never got enabled on this device - fire the start signal
			// immediately so anything gating on it (a role's turn prompt, on
			// every device in the room) doesn't wait on narration that will
			// never actually happen.
			onStart?.();
			return;
		}
		narrate(text, i18n.lang, onStart);
	}

	$effect(() => {
		const phase = gameStore.state?.phase;
		if (!phase || phase === lastPhase) return;
		lastPhase = phase;
		if (phase === 'NIGHT_ACTIONS') say(t.nightBegins);
		// A host stop-and-restart (RoomStopGame/"再来一局") resets phase to
		// SEATING (a fresh room starts at LOBBY) - cut off whatever might
		// still be queued rather than letting it run over the now-reset round.
		// Safe for normal flow too: SEATING itself never triggers a line here,
		// so this only ever catches leftover audio from before the reset.
		if (phase === 'LOBBY' || phase === 'SEATING') stopNarration();
	});

	// "天亮了" fires the instant DAWN actually begins (pendingNightAnnounce
	// flips true the moment the night's last stage resolves - before the host
	// has tapped anything) - NOT gated on the host's own "公布夜晚结果" tap,
	// which only reveals WHO died (the separate lastNightDeaths effect below).
	// Self-resetting: pendingNightAnnounce naturally goes back to false once
	// announced, so this is armed again for the next night with no extra flag.
	$effect(() => {
		const pending = gameStore.state?.pendingNightAnnounce ?? false;
		if (pending === lastPendingNightAnnounce) return;
		lastPendingNightAnnounce = pending;
		if (pending) say(t.dawnBreaks);
	});

	$effect(() => {
		// S4: the shared state.stage is role-redacted for everyone - this
		// component only ever renders for the host (see +page.svelte), who gets
		// the real role via the private hostStage channel instead.
		const stage = gameStore.hostStage;
		const key = stage ? (stage.kind === 'ROLE_TURN' ? stage.role : 'COUPLE_REVEAL') : null;
		if (key === lastStageKey) return;
		lastStageKey = key;
		if (key === 'COUPLE_REVEAL') {
			say(t.cupidClose);
			say(t.coupleReveal);
		} else if (key && roleLineKeys[key as Role]) {
			// Every other client's NightActionPrompt for this role is held back
			// until this specific line actually starts speaking (see gameStore's
			// pendingTurnRole) - relay the moment it does, not just when it's queued.
			say(t[roleLineKeys[key as Role]!], () => {
				void sendAction({ kind: 'NightNarrationStarted', role: key as Role });
			});
		}
	});

	// The following four cover events that never had a recorded clip at all -
	// each guarded the same way as lastPhase/lastStageKey above, so a reactive
	// re-run (e.g. an unrelated state field changing) doesn't repeat itself.
	$effect(() => {
		const deaths = gameStore.lastNightDeaths;
		if (deaths === lastNightDeaths) return;
		lastNightDeaths = deaths;
		if (deaths === null) return;
		say(formatNightDeaths(deaths, i18n.lang));
	});

	$effect(() => {
		const result = gameStore.lastDayResult;
		if (result === lastDayResult) return;
		lastDayResult = result;
		if (!result) return;
		say(formatDayResult({ ...result, lang: i18n.lang }));
	});

	$effect(() => {
		const result = gameStore.lastHunterResult;
		if (result === lastHunterResult) return;
		lastHunterResult = result;
		if (!result) return;
		say(formatHunterResult({ ...result, lang: i18n.lang }));
	});

	$effect(() => {
		const result = gameStore.gameOverResult;
		if (result === lastGameOver) return;
		lastGameOver = result;
		if (!result) return;
		say(formatGameOverText(result.winner, i18n.lang, true));
	});
</script>
