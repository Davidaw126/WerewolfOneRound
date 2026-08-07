<script lang="ts">
	import { fly } from 'svelte/transition';
	import { gameStore } from '$lib/client/gameStore.svelte';
	import { sendAction } from '$lib/client/socket';
	import type { AckResponse, ClientAction } from '$lib/shared/events';
	import type { SeatState } from '$lib/shared/gameTypes';
	import PixelSprite from './PixelSprite.svelte';

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

	/** Server-side rule rejections, which the UI normally prevents - reached
	 * only if the two disagree, so say why rather than silently un-submitting
	 * and looking like a dead button. */
	const RULE_MESSAGES: Record<string, string> = {
		antidote_spent: '解药已经用完了',
		poison_spent: '毒药已经用完了',
		witch_no_self_save: '女巫不能自救',
		witch_one_potion_per_night: '每晚只能使用一瓶药',
		no_kill_to_save: '今晚无人被袭击，无法使用解药',
		guard_repeat_target: '不能连续两晚守护同一位玩家',
		already_submitted: '你今晚已经行动过了',
		not_your_role: '这不是你的身份',
		feared: '你被恐惧了，今晚无法行动',
		thief_must_take_wolf: '两张底牌都是狼人，必须选择一张'
	};

	async function submit(action: ClientAction, description: string) {
		submitted = true;
		const res = await sendAction<AckResponse>(action);
		if (!res.ok) {
			submitted = false;
			gameStore.showToast(RULE_MESSAGES[res.error] ?? '操作失败，请重试');
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
			<span>轮到你了：{role}</span>
		</h3>

		{#if submitted}
			<p class="text-sm text-zinc-400">已提交，等待其他玩家…</p>
			{#if role === '预言家' && gameStore.lastSeerResult}
				<p class="text-sm">
					<span class="text-zinc-400">查验结果：</span>
					<span
						class="font-semibold {gameStore.lastSeerResult.isWolf ? 'text-wolf' : 'text-village'}"
					>
						{gameStore.lastSeerResult.targetSeat} 号是{gameStore.lastSeerResult.isWolf
							? '坏人'
							: '好人'}
					</span>
				</p>
			{/if}
		{:else if role === '普通狼人' || role === '预言家' || role === '守卫' || role === '狼美人' || role === '野孩子' || role === '摄梦人' || role === '恶灵骑士'}
			{#if role === '普通狼人' || role === '狼美人' || role === '恶灵骑士'}
				<p class="text-sm text-wolf">
					{wolfTeammates.length > 0
						? `你的狼队友：${wolfTeammates.map((s) => `${s} 号`).join('、')}`
						: '你是唯一的狼人'}
				</p>
			{/if}
			{#if role === '守卫' && guardLastSeat !== null}
				<p class="text-sm text-zinc-400">
					上一晚你守护了 {guardLastSeat} 号，今晚不能重复守护
				</p>
			{/if}
			<p class="text-sm text-zinc-400">
				{role === '普通狼人' ? '选择今晚要袭击的玩家：' : ''}
				{role === '预言家' ? '选择要查验的玩家：' : ''}
				{role === '守卫' ? '选择要守护的玩家：' : ''}
				{role === '狼美人' ? '选择要魅惑的玩家：' : ''}
				{role === '野孩子' ? '选择你的榜样（不可选自己）：' : ''}
				{role === '摄梦人' ? '选择今晚要摄梦的玩家：' : ''}
				{role === '恶灵骑士' ? '选择要恐惧的玩家：' : ''}
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
						{seat.seatNumber}号 {seat.username}
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
						`你选择了 ${singleTarget} 号`
					)}
				disabled={singleTarget === null}
				class="btn-primary w-full"
			>
				确认
			</button>
		{:else if role === '女巫'}
			<p class="text-sm">
				<span class="text-zinc-400">解药</span>
				<span class={witch?.antidoteAvailable ? 'text-village' : 'text-zinc-500'}>
					{witch?.antidoteAvailable ? '✅剩余' : '❌已用完'}
				</span>
				<span class="mx-2 text-line">|</span>
				<span class="text-zinc-400">毒药</span>
				<span class={witch?.poisonAvailable ? 'text-village' : 'text-zinc-500'}>
					{witch?.poisonAvailable ? '✅剩余' : '❌已用完'}
				</span>
			</p>
			<p class="text-sm text-zinc-400">
				{killedSeat ? `今晚 ${killedSeat} 号被袭击` : '今晚无人被袭击'}
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
					<span class="text-sm text-bone">使用解药救 {killedSeat} 号</span>
				</button>
				{#if isSelfKill}
					<p class="text-sm text-wolf">女巫不能自救</p>
				{:else if poisonTarget !== null}
					<p class="text-sm text-zinc-400">每晚只能使用一瓶药</p>
				{/if}
			{/if}
			{#if witch?.poisonAvailable}
				<p class="text-sm text-zinc-400">选择要毒杀的玩家（可不选）：</p>
				{#if useAntidote}
					<p class="text-sm text-zinc-400">本晚已选择使用解药，不能同时用毒</p>
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
							{seat.seatNumber}号 {seat.username}
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
							useAntidote ? `你使用解药救了 ${killedSeat} 号` : null,
							poisonTarget ? `你毒杀了 ${poisonTarget} 号` : null
						]
							.filter(Boolean)
							.join('，') || '你没有使用解药或毒药'
					)}
				class="btn-primary w-full"
			>
				确认
			</button>
		{:else if role === '丘比特'}
			<p class="text-sm text-zinc-400">选择两名玩家组成情侣：</p>
			<div class="grid grid-cols-4 gap-2">
				{#each livingSeats as seat (seat.seatNumber)}
					{@const picked = seat.seatNumber === coupleFirst || seat.seatNumber === coupleSecond}
					<button
						onclick={() => pickCupidSeat(seat.seatNumber)}
						class="seat-btn relative {picked ? 'border-ember bg-ember/20 text-ember' : ''}"
					>
						{seat.seatNumber}号 {seat.username}
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
						`你将 ${coupleFirst} 号和 ${coupleSecond} 号连结为情侣`
					)}
				disabled={coupleFirst === null || coupleSecond === null}
				class="btn-primary w-full"
			>
				确认
			</button>
		{:else if role === '盗贼'}
			{#if gameStore.thiefChoice}
				<p class="text-sm text-zinc-400">
					底牌是：{gameStore.thiefChoice[0]} / {gameStore.thiefChoice[1]}
				</p>
				<div class="flex gap-2">
					<button
						onclick={() => (thiefPick = thiefPick === 'buried1' ? null : 'buried1')}
						class="seat-btn flex-1 px-3 {thiefPick === 'buried1'
							? 'border-ember bg-ember/20 text-ember'
							: ''}"
					>
						换第一张（{gameStore.thiefChoice[0]}）
					</button>
					<button
						onclick={() => (thiefPick = thiefPick === 'buried2' ? null : 'buried2')}
						class="seat-btn flex-1 px-3 {thiefPick === 'buried2'
							? 'border-ember bg-ember/20 text-ember'
							: ''}"
					>
						换第二张（{gameStore.thiefChoice[1]}）
					</button>
				</div>
				<button
					onclick={() => (thiefPick = thiefPick === 'keep' ? null : 'keep')}
					class="btn-ghost w-full py-2 text-sm {thiefPick === 'keep'
						? 'border-ember text-ember'
						: ''}"
				>
					保留原身份
				</button>
				<button
					onclick={() => {
						if (thiefPick === null) return;
						const swap = thiefPick === 'keep' ? null : thiefPick;
						const description =
							thiefPick === 'keep'
								? '你保留了原身份'
								: `你换成了${thiefPick === 'buried1' ? gameStore.thiefChoice![0] : gameStore.thiefChoice![1]}`;
						submit({ kind: 'NightSubmitAction', action: { role: '盗贼', swap } }, description);
					}}
					disabled={thiefPick === null}
					class="btn-primary w-full"
				>
					确认
				</button>
			{:else}
				<p class="text-sm text-zinc-500">正在加载底牌…</p>
			{/if}
		{:else if role === '猎人'}
			<!-- The live thumbs up/down a physical host gives the hunter each
			     night. Same hunterCanShoot() verdict the server will apply if
			     they die tonight, so the two can never disagree. -->
			{#if ctx?.hunter}
				{#if ctx.hunter.canShoot}
					<p class="text-sm font-semibold text-village">👍 你今晚可以开枪</p>
				{:else}
					<p class="text-sm font-semibold text-wolf">👎 你身中剧毒，无法开枪</p>
				{/if}
			{/if}
			<p class="text-sm text-zinc-400">猎人夜晚无需行动，等待主持人继续。</p>
		{/if}
	</div>
{/if}
