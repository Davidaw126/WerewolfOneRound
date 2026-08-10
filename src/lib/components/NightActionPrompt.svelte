<script lang="ts">
	import { fly } from 'svelte/transition';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { i18n } from '$lib/client/i18n.svelte';
	import { strings, roleName, seatLabel } from '$lib/shared/i18n';
	import type { AckResponse, ClientAction } from '$lib/shared/events';
	import type { SeatState } from '$lib/shared/gameTypes';
	import PixelSprite from './PixelSprite.svelte';

	const t = $derived(strings(i18n.lang).nightPrompt);

	const role = $derived(gameStore.myTurnRole);
	const seats = $derived(gameStore.state?.seats ?? []);
	const livingSeats = $derived(seats.filter((s: SeatState) => s.sessionId !== null && !s.isDead));

	// Private per-turn info from the server (see TurnContext). Everything the
	// UI disables below is ALSO enforced server-side - this is only UX.
	const ctx = $derived(gameStore.turnContext);
	const witch = $derived(ctx?.witch);
	const killedSeat = $derived(witch?.killedSeat ?? null);
	const guardLastSeat = $derived(ctx?.guard?.lastProtectedSeat ?? null);
	const wolfTeammates = $derived(ctx?.wolf?.teammateSeats ?? []);
	/** The witch was the one attacked tonight - she may not save herself. */
	const isSelfKill = $derived(killedSeat !== null && killedSeat === ctx?.seat);

	let submitted = $state(false);
	// Single-target roles (wolf/seer/guard/wolf-beauty).
	let singleTarget = $state<number | null>(null);
	// Witch.
	let poisonTarget = $state<number | null>(null);
	let useAntidote = $state(false);
	// Cupid.
	let coupleFirst = $state<number | null>(null);
	let coupleSecond = $state<number | null>(null);
	// Thief.
	let thiefPick = $state<'buried1' | 'buried2' | 'keep' | null>(null);

	$effect(() => {
		// Reset local draft state whenever a new turn begins.
		void role;
		submitted = false;
		singleTarget = null;
		poisonTarget = null;
		useAntidote = false;
		coupleFirst = null;
		coupleSecond = null;
		thiefPick = null;
	});

	function pickCupidSeat(seatNumber: number) {
		if (coupleFirst === seatNumber) {
			coupleFirst = null;
		} else if (coupleSecond === seatNumber) {
			coupleSecond = null;
		} else if (coupleFirst === null) {
			coupleFirst = seatNumber;
		} else if (coupleSecond === null) {
			coupleSecond = seatNumber;
		}
		// Both slots already filled with two other seats - ignore further taps
		// until one is cleared, rather than silently replacing a choice.
	}

	async function submit(action: ClientAction, description: string) {
		submitted = true;
		const res = await sendAction<AckResponse>(action);
		if (!res.ok) {
			submitted = false;
			const messages = t.ruleMessages;
			gameStore.showToast(
				(messages as unknown as Record<string, string>)[res.error] ?? messages.fallback
			);
			return;
		}
		gameStore.logActivity(description);
		// A page-level banner (not nested in this component) so it survives if
		// the server advances the stage - and unmounts this whole prompt -
		// before the 3s would otherwise have elapsed.
		gameStore.showConfirm(`✓ ${description}`, 3000);
	}
</script>

{#if role}
	<div transition:fly={{ y: -10, duration: 200 }} class="panel space-y-3 p-4">
		<h3 class="flex items-center gap-3 font-display text-lg font-semibold text-ember">
			<PixelSprite {role} px={40} />
			<span>{t.yourTurn(roleName(role, i18n.lang))}</span>
		</h3>

		{#if submitted}
			<p class="text-sm text-zinc-400">{t.submittedWaiting}</p>
			{#if role === '预言家' && gameStore.lastSeerResult}
				<p class="text-sm">
					<span
						class="font-semibold {gameStore.lastSeerResult.isWolf ? 'text-wolf' : 'text-village'}"
					>
						{t.checkResult(gameStore.lastSeerResult.targetSeat, gameStore.lastSeerResult.isWolf)}
					</span>
				</p>
			{/if}
		{:else if role === '普通狼人' || role === '预言家' || role === '守卫' || role === '狼美人' || role === '野孩子' || role === '摄梦人' || role === '恶灵骑士'}
			{#if role === '普通狼人' || role === '狼美人' || role === '恶灵骑士'}
				<p class="text-sm text-wolf">
					{wolfTeammates.length > 0
						? t.wolfTeammates(wolfTeammates.map((s) => seatLabel(s, i18n.lang)).join('、'))
						: t.soloWolf}
				</p>
			{/if}
			{#if role === '守卫' && guardLastSeat !== null}
				<p class="text-sm text-zinc-400">
					{t.guardLastProtected(guardLastSeat)}
				</p>
			{/if}
			<p class="text-sm text-zinc-400">
				{role === '普通狼人' ? t.selectWolfTarget : ''}
				{role === '预言家' ? t.selectSeerTarget : ''}
				{role === '守卫' ? t.selectGuardTarget : ''}
				{role === '狼美人' ? t.selectWolfBeautyTarget : ''}
				{role === '野孩子' ? t.selectWildChildTarget : ''}
				{role === '摄梦人' ? t.selectDreamWeaverTarget : ''}
				{role === '恶灵骑士' ? t.selectNightmareTarget : ''}
			</p>
			<div class="grid grid-cols-4 gap-2">
				{#each livingSeats as seat (seat.seatNumber)}
					{@const blocked = role === '守卫' && seat.seatNumber === guardLastSeat}
					<button
						disabled={blocked}
						onclick={() =>
							(singleTarget = singleTarget === seat.seatNumber ? null : seat.seatNumber)}
						class="seat-btn relative {singleTarget === seat.seatNumber
							? 'border-ember bg-ember/20 text-ember'
							: ''}"
					>
						{seatLabel(seat.seatNumber, i18n.lang)}
						{seat.username}
						{#if singleTarget === seat.seatNumber}
							<span
								class="absolute -top-1.5 -right-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-line bg-ember text-[9px] text-black"
							>
								✓
							</span>
						{/if}
					</button>
				{/each}
			</div>
			<button
				onclick={() =>
					singleTarget !== null &&
					submit(
						{ kind: 'NightSubmitAction', action: { role, targetSeat: singleTarget } },
						t.descSelectedSeat(singleTarget)
					)}
				disabled={singleTarget === null}
				class="btn-primary w-full"
			>
				{t.confirm}
			</button>
		{:else if role === '女巫'}
			<p class="text-sm">
				<span class="text-zinc-400">{t.witchAntidoteLabel}</span>
				<span class={witch?.antidoteAvailable ? 'text-village' : 'text-zinc-500'}>
					{witch?.antidoteAvailable ? t.witchAvailable : t.witchSpent}
				</span>
				<span class="mx-2 text-line">|</span>
				<span class="text-zinc-400">{t.witchPoisonLabel}</span>
				<span class={witch?.poisonAvailable ? 'text-village' : 'text-zinc-500'}>
					{witch?.poisonAvailable ? t.witchAvailable : t.witchSpent}
				</span>
			</p>
			<p class="text-sm text-zinc-400">
				{killedSeat ? t.witchKilledTonight(killedSeat) : t.witchNoOneKilled}
			</p>
			{#if killedSeat !== null && witch?.antidoteAvailable}
				{@const antidoteBlocked = isSelfKill || poisonTarget !== null}
				<button
					type="button"
					disabled={antidoteBlocked}
					onclick={() => {
						// Mutual exclusion enforced in the handler too, so no tap
						// order can build an invalid draft.
						useAntidote = !useAntidote;
						if (useAntidote) poisonTarget = null;
					}}
					class="flex w-full items-center gap-3 border-[3px] border-line p-2 text-left disabled:cursor-not-allowed disabled:opacity-50 {useAntidote
						? 'bg-surface-2'
						: 'bg-surface'}"
				>
					<span
						class="flex h-6 w-6 flex-none items-center justify-center border-2 border-line text-sm {useAntidote
							? 'bg-village text-black'
							: 'bg-line text-transparent'}">✓</span
					>
					<span class="text-sm text-bone">{t.witchUseAntidote(killedSeat)}</span>
				</button>
				{#if isSelfKill}
					<p class="text-sm text-wolf">{t.witchSelfSaveBlocked}</p>
				{:else if poisonTarget !== null}
					<p class="text-sm text-zinc-400">{t.witchOnePotionPerNight}</p>
				{/if}
			{/if}
			{#if witch?.poisonAvailable}
				<p class="text-sm text-zinc-400">{t.witchSelectPoisonTarget}</p>
				{#if useAntidote}
					<p class="text-sm text-zinc-400">{t.witchAntidoteChosenAlready}</p>
				{/if}
				<div class="grid grid-cols-4 gap-2">
					{#each livingSeats as seat (seat.seatNumber)}
						<button
							disabled={useAntidote}
							onclick={() => {
								poisonTarget = poisonTarget === seat.seatNumber ? null : seat.seatNumber;
								if (poisonTarget !== null) useAntidote = false;
							}}
							class="seat-btn relative {poisonTarget === seat.seatNumber
								? 'border-wolf bg-wolf/20 text-wolf'
								: 'hover:border-wolf/60'}"
						>
							{seatLabel(seat.seatNumber, i18n.lang)}
							{seat.username}
							{#if poisonTarget === seat.seatNumber}
								<span
									class="absolute -top-1.5 -right-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-line bg-wolf text-[9px] text-bone"
								>
									✓
								</span>
							{/if}
						</button>
					{/each}
				</div>
			{/if}
			<button
				onclick={() =>
					submit(
						{
							kind: 'NightSubmitAction',
							action: { role: '女巫', poisonTarget, useAntidote }
						},
						[
							useAntidote ? t.descWitchSaved(killedSeat!) : null,
							poisonTarget ? t.descWitchPoisoned(poisonTarget) : null
						]
							.filter(Boolean)
							.join(i18n.lang === 'zh' ? '，' : '; ') || t.descWitchNoAction
					)}
				class="btn-primary w-full"
			>
				{t.confirm}
			</button>
		{:else if role === '丘比特'}
			<p class="text-sm text-zinc-400">{t.cupidSelectTwo}</p>
			<div class="grid grid-cols-4 gap-2">
				{#each livingSeats as seat (seat.seatNumber)}
					{@const picked = seat.seatNumber === coupleFirst || seat.seatNumber === coupleSecond}
					<button
						onclick={() => pickCupidSeat(seat.seatNumber)}
						class="seat-btn relative {picked ? 'border-ember bg-ember/20 text-ember' : ''}"
					>
						{seatLabel(seat.seatNumber, i18n.lang)}
						{seat.username}
						{#if picked}
							<span
								class="absolute -top-1.5 -right-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-line bg-ember text-[9px] text-black"
							>
								✓
							</span>
						{/if}
					</button>
				{/each}
			</div>
			<button
				onclick={() =>
					coupleFirst !== null &&
					coupleSecond !== null &&
					submit(
						{
							kind: 'NightSubmitAction',
							action: { role: '丘比特', seatA: coupleFirst, seatB: coupleSecond }
						},
						t.descCupidLinked(coupleFirst, coupleSecond)
					)}
				disabled={coupleFirst === null || coupleSecond === null}
				class="btn-primary w-full"
			>
				{t.confirm}
			</button>
		{:else if role === '盗贼'}
			{#if gameStore.thiefChoice}
				<p class="text-sm text-zinc-400">
					{t.thiefBuriedCards(
						roleName(gameStore.thiefChoice[0], i18n.lang),
						roleName(gameStore.thiefChoice[1], i18n.lang)
					)}
				</p>
				<div class="flex gap-2">
					<button
						onclick={() => (thiefPick = thiefPick === 'buried1' ? null : 'buried1')}
						class="seat-btn flex-1 px-3 {thiefPick === 'buried1'
							? 'border-ember bg-ember/20 text-ember'
							: ''}"
					>
						{t.thiefSwapFirst(roleName(gameStore.thiefChoice[0], i18n.lang))}
					</button>
					<button
						onclick={() => (thiefPick = thiefPick === 'buried2' ? null : 'buried2')}
						class="seat-btn flex-1 px-3 {thiefPick === 'buried2'
							? 'border-ember bg-ember/20 text-ember'
							: ''}"
					>
						{t.thiefSwapSecond(roleName(gameStore.thiefChoice[1], i18n.lang))}
					</button>
				</div>
				<button
					onclick={() => (thiefPick = thiefPick === 'keep' ? null : 'keep')}
					class="btn-ghost w-full py-2 text-sm {thiefPick === 'keep'
						? 'border-ember text-ember'
						: ''}"
				>
					{t.thiefKeepOriginal}
				</button>
				<button
					onclick={() => {
						if (thiefPick === null) return;
						const swap = thiefPick === 'keep' ? null : thiefPick;
						const description =
							thiefPick === 'keep'
								? t.descThiefKept
								: t.descThiefSwapped(
										roleName(
											thiefPick === 'buried1'
												? gameStore.thiefChoice![0]
												: gameStore.thiefChoice![1],
											i18n.lang
										)
									);
						submit({ kind: 'NightSubmitAction', action: { role: '盗贼', swap } }, description);
					}}
					disabled={thiefPick === null}
					class="btn-primary w-full"
				>
					{t.confirm}
				</button>
			{:else}
				<p class="text-sm text-zinc-500">{t.thiefLoadingCards}</p>
			{/if}
		{:else if role === '猎人'}
			<!-- The live thumbs up/down a physical host gives the hunter each
			     night. Same hunterCanShoot() verdict the server will apply if
			     they die tonight, so the two can never disagree. -->
			{#if ctx?.hunter}
				{#if ctx.hunter.canShoot}
					<p class="text-sm font-semibold text-village">{t.hunterCanShoot}</p>
				{:else}
					<p class="text-sm font-semibold text-wolf">{t.hunterPoisonedNoShoot}</p>
				{/if}
			{/if}
			<p class="text-sm text-zinc-400">{t.hunterNoActionNeeded}</p>
		{/if}
	</div>
{/if}
