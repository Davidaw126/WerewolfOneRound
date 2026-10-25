<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import {
		narrate,
		stopNarration,
		primeSpeech,
		onSpeechBlocked,
		dropQueuedNarration
	} from '$lib/client/sfx';
	import { sendAction } from '$lib/client/socket';
	import { audioSettings } from '$lib/client/audioSettings.svelte';
	import { i18n } from '$lib/client/i18n.svelte';
	import {
		strings,
		formatNightDeaths,
		formatDayResult,
		formatGameOverText,
		type Strings
	} from '$lib/shared/i18n';
	import type { Role } from '$lib/shared/roles';

	let unlocked = $state(false);
	let warnedLocked = false;
	let lastPhase: string | null = null;
	let lastStageKey: string | null = null;
	let lastNightDeaths: number[] | null = null;
	let lastDayResult: unknown = null;
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
		猎人: 'hunterTurn',
		// Only his own 确认开枪状态 stage reaches here: during the pack's turn
		// the host's stage is 普通狼人.
		黑狼王: 'blackWolfKingTurn',
		// Without a line these three never relayed NightNarrationStarted, so
		// their holder's prompt always sat behind the 8s fallback.
		野孩子: 'wildChildTurn',
		摄梦人: 'dreamWeaverTurn',
		恶灵骑士: 'nightmareTurn'
	};

	function unlockAudio() {
		// iOS WebKit only lets speech start after a gesture-initiated speak();
		// primeSpeech does that with a silent, non-empty utterance (see its
		// own comment for why the old whitespace-only line never worked on
		// iPhone). Runs on EVERY tap, not just the first: after the first it
		// only nudges a paused engine back awake, which iOS needs after the
		// app has been backgrounded.
		primeSpeech();
		unlocked = true;
	}

	onMount(() => {
		// Piggyback on whatever the host naturally taps (their seat, a config
		// control, the start button) - by the time NIGHT_ACTIONS begins they've
		// long since tapped something. If they haven't (e.g. the page reloaded
		// mid-game), the enable button below asks for that one tap.
		// The END of a tap: iOS only lets speech start from a real activation
		// event (touchend/click/pointerup), never pointerdown/touchstart.
		const events = ['touchend', 'pointerup', 'click', 'keydown'] as const;
		for (const e of events) document.addEventListener(e, unlockAudio, { capture: true });
		return () => {
			for (const e of events) document.removeEventListener(e, unlockAudio, { capture: true });
		};
	});

	// If a phone refuses a line, say so - otherwise the host only notices
	// the silence much later. One tap anywhere fixes it.
	onMount(() => {
		onSpeechBlocked(() =>
			gameStore.showInfoPopup(strings(i18n.lang).narration.voiceBlocked, 'bad', 8000)
		);
		return () => onSpeechBlocked(null);
	});

	onDestroy(() => {
		stopNarration();
	});

	function say(text: string, onStart?: () => void, tag?: string) {
		if (!unlocked) {
			// Audio never got enabled on this device - fire the start signal
			// immediately so anything gating on it (a role's turn prompt, on
			// every device in the room) doesn't wait on narration that will
			// never actually happen.
			onStart?.();
			// Typically a page reload mid-game: no tap since, so the voice is
			// still locked. Say so once, instead of the lines going missing.
			if (!warnedLocked && audioSettings.effects) {
				warnedLocked = true;
				gameStore.showInfoPopup(strings(i18n.lang).narration.voiceBlocked, 'bad', 8000);
			}
			return;
		}
		narrate(text, i18n.lang, onStart, tag);
	}

	// ORDER MATTERS: Svelte runs these effects in declaration order, and a
	// single server batch often carries several at once - the day's vote
	// result, PhaseChanged to night, and the first role's turn all arrive
	// together after a vote. Results are declared first so they're spoken
	// first; the phase line and then the role call-out follow.
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
		const result = gameStore.gameOverResult;
		if (result === lastGameOver) return;
		lastGameOver = result;
		if (!result) return;
		say(formatGameOverText(result.winner, i18n.lang, true));
	});
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
		const leftCouple = lastStageKey === 'COUPLE_REVEAL';
		lastStageKey = key;
		// The previous turn is over - its call-out is useless if it hasn't
		// started speaking yet (see dropQueuedNarration).
		dropQueuedNarration('stage');
		// The lovers confirm on their own phones now, so the closing cue is
		// said here on the way out rather than by the host's 继续 button.
		if (leftCouple) say(t.allEyesClosed, undefined, 'stage');
		if (key === 'COUPLE_REVEAL') {
			say(t.cupidClose, undefined, 'stage');
			say(t.coupleReveal, undefined, 'stage');
		} else if (key && roleLineKeys[key as Role]) {
			// Every other client's NightActionPrompt for this role is held back
			// until this specific line actually starts speaking (see gameStore's
			// pendingTurnRole) - relay the moment it does, not just when it's queued.
			say(
				t[roleLineKeys[key as Role]!],
				() => {
					void sendAction({ kind: 'NightNarrationStarted', role: key as Role }, { quiet: true });
				},
				'stage'
			);
		}
	});
</script>

<!-- No 点击开启语音播报 banner: any tap on the page unlocks the voice (see
     onMount), and the host has always tapped plenty by nightfall. The manual
     test/unlock lives in 上帝之手 (HostOverridePanel) for the odd case, e.g. a
     refresh mid-night. -->
