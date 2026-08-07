<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { narrate, stopNarration } from '$lib/client/sfx';
	import { sendAction } from '$lib/client/socket';
	import type { Role } from '$lib/shared/roles';

	let unlocked = $state(false);
	let lastPhase: string | null = null;
	let lastStageKey: string | null = null;
	let lastNightDeaths: number[] | null = null;
	let lastDayResult: unknown = null;
	let lastHunterResult: unknown = null;
	let lastGameOver: unknown = null;
	let lastPendingNightAnnounce = false;

	// Moderator-style call-outs, one per role with a night action.
	const roleLines: Partial<Record<Role, string>> = {
		普通狼人: '狼人请睁眼，请选择今晚的目标',
		预言家: '预言家请睁眼，请选择要查验的玩家',
		女巫: '女巫请睁眼，你要使用解药或毒药吗',
		守卫: '守卫请睁眼，请选择要守护的玩家',
		狼美人: '狼美人请睁眼，请选择要魅惑的玩家',
		丘比特: '丘比特请睁眼，请选择两名玩家结为情侣',
		盗贼: '盗贼请睁眼，请选择是否更换身份',
		猎人: '猎人请确认你的身份'
	};

	// §8.3 LOVERS_CONFIRM - two beats, not one: Cupid needs to actually close
	// their eyes before the two lovers are told to open theirs (privacy, same
	// as every other night role's turn), so this is two separate narrate()
	// calls (which queue and play in sequence) rather than one combined line.
	// Neither is keyed in roleLines - not a Role, and no NightNarrationStarted
	// relay for either (see the stage effect below): nothing else gates its
	// own reveal on this line starting, unlike a real role's turn prompt.
	const cupidCloseLine = '丘比特请闭眼';
	const coupleRevealLine = '玩家们请睁眼，确认是否被连为情侣';

	function unlockAudio() {
		unlocked = true;
		// Some browsers only allow speechSynthesis to actually produce audio
		// after a real user gesture - a near-silent utterance here "unlocks"
		// the pipeline the same way the old silent-clip trick did.
		narrate(' ');
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
		narrate(text, onStart);
	}

	$effect(() => {
		const phase = gameStore.state?.phase;
		if (!phase || phase === lastPhase) return;
		lastPhase = phase;
		if (phase === 'NIGHT_ACTIONS') say('天黑请闭眼');
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
		if (pending) say('天亮了');
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
			say(cupidCloseLine);
			say(coupleRevealLine);
		} else if (key && roleLines[key as Role]) {
			// Every other client's NightActionPrompt for this role is held back
			// until this specific line actually starts speaking (see gameStore's
			// pendingTurnRole) - relay the moment it does, not just when it's queued.
			say(roleLines[key as Role]!, () => {
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
		say(deaths.length === 0 ? '昨夜是平安夜' : `昨夜 ${deaths.join('、')} 号玩家死亡`);
	});

	$effect(() => {
		const result = gameStore.lastDayResult;
		if (result === lastDayResult) return;
		lastDayResult = result;
		if (!result) return;
		const base = result.tie
			? '投票平票，本轮无人出局'
			: result.eliminatedSeat === null
				? '本轮无人出局'
				: `${result.eliminatedSeat} 号玩家被投票出局，他的身份是 ${result.identity}`;
		say(result.followDeathSeat !== null ? `${base}，${result.followDeathSeat} 号殉情身亡` : base);
	});

	$effect(() => {
		const result = gameStore.lastHunterResult;
		if (result === lastHunterResult) return;
		lastHunterResult = result;
		if (!result) return;
		const base =
			result.shotSeat === null
				? `${result.hunterSeat} 号猎人选择不开枪`
				: `${result.hunterSeat} 号猎人开枪，带走了 ${result.shotSeat} 号玩家`;
		say(result.followDeathSeat !== null ? `${base}，${result.followDeathSeat} 号殉情身亡` : base);
	});

	$effect(() => {
		const result = gameStore.gameOverResult;
		if (result === lastGameOver) return;
		lastGameOver = result;
		if (!result) return;
		say(
			result.winner === 'wolves'
				? '狼人阵营胜利，游戏结束'
				: result.winner === 'lovers'
					? '第三方阵营胜利，游戏结束'
					: '好人阵营胜利，游戏结束'
		);
	});
</script>
