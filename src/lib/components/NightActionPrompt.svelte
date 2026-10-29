<script lang="ts">
	import { fly } from 'svelte/transition';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import { i18n } from '$lib/client/i18n.svelte';
	import { strings, roleName, seatLabel } from '$lib/shared/i18n';
	import type { SeatState } from '$lib/shared/gameTypes';
	import PixelSprite from './PixelSprite.svelte';
	import { renderLine } from '$lib/client/logLines';
	import { NightDraft, PickDraft, type Submission } from '$lib/client/turnDraft.svelte';
	import { promptFor, selectLabelFor, statusLabelFor } from '$lib/client/roleNight';
	import { PACK_MEMBER_ROLES } from '$lib/game/roleMeta';

	const t = $derived(strings(i18n.lang).nightPrompt);

	const role = $derived(gameStore.myTurnRole);
	// Which prompt this turn shows, and how it asks - see client/roleNight.ts.
	const prompt = $derived(role ? promptFor(role, gameStore.turnRules.packTurn) : null);
	const selectLabel = $derived(role ? selectLabelFor(role, gameStore.turnRules.packTurn) : null);
	const seats = $derived(gameStore.state?.seats ?? []);
	const livingSeats = $derived(seats.filter((s: SeatState) => s.sessionId !== null && !s.isDead));

	// Private per-turn info from the server (see TurnContext), and the turn's
	// rules derived from it in the store. UX only - the server enforces all.
	const ctx = $derived(gameStore.turnContext);
	const witch = $derived(ctx?.witch);
	const rules = $derived(gameStore.turnRules);
	const killedSeat = $derived(rules.killedSeat);
	const guardLastSeat = $derived(rules.guardLastSeat);
	const wolfTeammates = $derived(rules.wolfTeammates);
	const packTurn = $derived(rules.packTurn);
	const isSelfKill = $derived(rules.isSelfKill);
	const noSelfPick = $derived(rules.noSelfPick);
	const onePotionOnly = $derived(rules.onePotionOnly);

	// What's picked so far on this turn - a fresh draft per turn (see
	// client/turnDraft.svelte.ts), so nothing carries over.
	const draft = $derived.by(() => {
		void role;
		return new NightDraft(() => gameStore.turnRules);
	});

	async function submit(submission: Submission | null) {
		if (!submission) return;
		const { action, entry } = submission;
		const turn = draft;
		turn.sent = true;
		const res = await sendAction(action);
		if (!res.ok) {
			// The reason pops up via sendAction's global error handler.
			turn.sent = false;
			return;
		}
		gameStore.logActivity(entry);
		// A page-level banner (not nested in this component) so it survives if
		// the server advances the stage - and unmounts this whole prompt -
		// before the 3s would otherwise have elapsed.
		gameStore.showConfirm(t.doneCloseEyes(renderLine(entry, i18n.lang)), 4000);
	}
</script>

{#if role}
	<div transition:fly={{ y: -10, duration: 200 }} class="panel space-y-3 p-4">
		<h3 class="flex items-center gap-3 font-display text-lg font-semibold text-ember">
			<PixelSprite {role} px={40} />
			<span>{t.yourTurn(roleName(role, i18n.lang))}</span>
		</h3>

		{#if draft.sent || gameStore.packKill || gameStore.roleDoneByOther}
			<p class="text-sm font-semibold text-village">
				{draft.sent
					? t.submittedWaiting
					: gameStore.packKill
						? t.packKillChosen(gameStore.packKill.bySeat, gameStore.packKill.target)
						: t.roleDoneByOther}
			</p>
			{#if role === 'SEER' && gameStore.lastSeerResult}
				<!-- Kept on screen after submitting: the result popup alone is
				     gone in a few seconds. -->
				<p
					class="text-sm font-semibold {gameStore.lastSeerResult.isWolf
						? 'text-wolf'
						: 'text-village'}"
				>
					{t.checkResult(gameStore.lastSeerResult.targetSeat, gameStore.lastSeerResult.isWolf)}
				</p>
			{/if}
		{:else if ctx?.feared && role !== 'NIGHTMARE'}
			<!-- 恶灵骑士 blocked this seat's skill tonight. Passing still goes
			     through the normal submit + auto-advance, so the pause before
			     the next role is the same as for a real action. -->
			<p class="text-sm text-wolf">{t.fearedTonight}</p>
			<button onclick={() => submit(NightDraft.pass())} class="btn-primary w-full">
				{t.fearedPass}
			</button>
			{#if role === 'SEER' && gameStore.lastSeerResult}
				<p class="text-sm">
					<span
						class="font-semibold {gameStore.lastSeerResult.isWolf ? 'text-wolf' : 'text-village'}"
					>
						{t.checkResult(gameStore.lastSeerResult.targetSeat, gameStore.lastSeerResult.isWolf)}
					</span>
				</p>
			{/if}
		{:else if prompt === 'status'}
			<!-- The live thumbs up/down a physical host gives the hunter (and
			     黑狼王, on his own 确认开枪状态 stage - his pack-kill turn has no
			     `hunter` context) each night. Same verdict the server will
			     apply if they die tonight, so the two can never disagree. -->
			{#if ctx?.hunter}
				{#if ctx.hunter.canShoot}
					<p class="text-sm font-semibold text-village">{t.hunterCanShoot}</p>
				{:else}
					<p class="text-sm font-semibold text-wolf">{t.hunterPoisonedNoShoot}</p>
				{/if}
			{/if}
			{#if gameStore.stageConfirmed}
				<p class="text-sm text-zinc-400">{strings(i18n.lang).room.stageConfirmedWait}</p>
			{:else}
				<p class="text-sm text-zinc-400">
					{t[statusLabelFor(role)]}
				</p>
				<!-- Everyone else - the host included - has their eyes shut, so
				     the shooter moves the night on themselves. -->
				<button
					onclick={() => sendAction({ kind: 'NightConfirmStage' })}
					class="btn-primary w-full"
				>
					{t.statusConfirm}
				</button>
			{/if}
		{:else if prompt === 'pick'}
			{#if PACK_MEMBER_ROLES.has(role)}
				<p class="text-sm text-wolf">
					{wolfTeammates.length > 0
						? t.wolfTeammates(wolfTeammates.map((s) => seatLabel(s, i18n.lang)).join('、'))
						: t.soloWolf}
				</p>
			{/if}
			{#if role === 'GUARD' && guardLastSeat !== null}
				<p class="text-sm text-zinc-400">
					{t.guardLastProtected(guardLastSeat)}
				</p>
			{/if}
			<p class="text-sm text-zinc-400">
				{#if selectLabel}{t[selectLabel]}{/if}
			</p>
			<div class="grid grid-cols-4 gap-2">
				{#each livingSeats.filter((s) => !(noSelfPick && s.seatNumber === ctx?.seat)) as seat (seat.seatNumber)}
					{@const blocked = role === 'GUARD' && seat.seatNumber === guardLastSeat}
					<button
						disabled={blocked}
						onclick={() => draft.pick.tap(seat.seatNumber)}
						class="seat-btn relative {draft.pick.target === seat.seatNumber
							? 'border-ember bg-ember/20 text-ember'
							: ''}"
					>
						{seatLabel(seat.seatNumber, i18n.lang)}
						{seat.username}
						{#if draft.pick.target === seat.seatNumber}
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
				onclick={() => submit(draft.pick.submission(role))}
				disabled={draft.pick.target === null}
				class="btn-primary w-full"
			>
				{t.confirm}
			</button>
			{#if packTurn && ctx?.wolf?.allowEmptyKill}
				<!-- 空刀: only offered when the room's rules allow it. -->
				<button
					onclick={() => submit(PickDraft.emptyKill(role))}
					class="btn-ghost w-full py-2 text-sm"
				>
					{t.emptyKill}
				</button>
			{/if}
		{:else if prompt === 'potions'}
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
				{!witch?.antidoteAvailable
					? t.witchKillHidden
					: killedSeat
						? t.witchKilledTonight(killedSeat)
						: t.witchNoOneKilled}
			</p>
			{#if killedSeat !== null && witch?.antidoteAvailable}
				<button
					type="button"
					disabled={draft.potions.antidoteBlocked}
					onclick={() => draft.potions.toggleAntidote()}
					class="flex w-full items-center gap-3 border-[3px] border-line p-2 text-left disabled:cursor-not-allowed disabled:opacity-50 {draft
						.potions.antidote
						? 'bg-surface-2'
						: 'bg-surface'}"
				>
					<span
						class="flex h-6 w-6 flex-none items-center justify-center border-2 border-line text-sm {draft
							.potions.antidote
							? 'bg-village text-black'
							: 'bg-line text-transparent'}">✓</span
					>
					<span class="text-sm text-bone">{t.witchUseAntidote(killedSeat)}</span>
				</button>
				{#if isSelfKill}
					<p class="text-sm text-wolf">{t.witchSelfSaveBlocked}</p>
				{:else if onePotionOnly && draft.potions.poison !== null}
					<p class="text-sm text-zinc-400">{t.witchOnePotionPerNight}</p>
				{/if}
			{/if}
			{#if witch?.poisonAvailable}
				<p class="text-sm text-zinc-400">{t.witchSelectPoisonTarget}</p>
				{#if draft.potions.poisonBlocked}
					<p class="text-sm text-zinc-400">{t.witchAntidoteChosenAlready}</p>
				{/if}
				<div class="grid grid-cols-4 gap-2">
					{#each livingSeats as seat (seat.seatNumber)}
						<button
							disabled={draft.potions.poisonBlocked}
							onclick={() => draft.potions.tapPoison(seat.seatNumber)}
							class="seat-btn relative {draft.potions.poison === seat.seatNumber
								? 'border-wolf bg-wolf/20 text-wolf'
								: 'hover:border-wolf/60'}"
						>
							{seatLabel(seat.seatNumber, i18n.lang)}
							{seat.username}
							{#if draft.potions.poison === seat.seatNumber}
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
			<button onclick={() => submit(draft.potions.submission())} class="btn-primary w-full">
				{t.confirm}
			</button>
		{:else if prompt === 'link'}
			<p class="text-sm text-zinc-400">{t.cupidSelectTwo}</p>
			<div class="grid grid-cols-4 gap-2">
				{#each livingSeats as seat (seat.seatNumber)}
					{@const picked = draft.link.has(seat.seatNumber)}
					<button
						onclick={() => draft.link.tap(seat.seatNumber)}
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
				onclick={() => submit(draft.link.submission())}
				disabled={draft.link.second === null || draft.link.first === null}
				class="btn-primary w-full"
			>
				{t.confirm}
			</button>
		{:else if prompt === 'thief'}
			{#if gameStore.thiefChoice}
				<p class="text-sm text-zinc-400">
					{t.thiefBuriedCards(
						roleName(gameStore.thiefChoice[0], i18n.lang),
						roleName(gameStore.thiefChoice[1], i18n.lang)
					)}
				</p>
				<div class="flex gap-2">
					<button
						onclick={() => draft.thief.choose('buried1')}
						class="seat-btn flex-1 px-3 {draft.thief.pick === 'buried1'
							? 'border-ember bg-ember/20 text-ember'
							: ''}"
					>
						{t.thiefSwapFirst(roleName(gameStore.thiefChoice[0], i18n.lang))}
					</button>
					<button
						onclick={() => draft.thief.choose('buried2')}
						class="seat-btn flex-1 px-3 {draft.thief.pick === 'buried2'
							? 'border-ember bg-ember/20 text-ember'
							: ''}"
					>
						{t.thiefSwapSecond(roleName(gameStore.thiefChoice[1], i18n.lang))}
					</button>
				</div>
				<button
					onclick={() => draft.thief.choose('keep')}
					class="btn-ghost w-full py-2 text-sm {draft.thief.pick === 'keep'
						? 'border-ember text-ember'
						: ''}"
				>
					{t.thiefKeepOriginal}
				</button>
				<button
					onclick={() => submit(draft.thief.submission(gameStore.thiefChoice!))}
					disabled={draft.thief.pick === null}
					class="btn-primary w-full"
				>
					{t.confirm}
				</button>
			{:else}
				<p class="text-sm text-zinc-500">{t.thiefLoadingCards}</p>
			{/if}
		{/if}
	</div>
{/if}
