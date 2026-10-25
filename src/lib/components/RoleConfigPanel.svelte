<script lang="ts">
	import { fly } from 'svelte/transition';
	import { ALL_ROLES, roleTeam, type Role } from '$lib/shared/roles';
	import { SUPPORTED_LEGACY_ROLES, roleIdToLegacy } from '$lib/game/roleBridge';
	import { PRESET_BOARDS } from '$lib/game/rules/presets';
	import { defaultRuleConfig } from '$lib/game/defaultRuleConfig';
	import type { RoleId } from '$lib/game/types';
	import { sendAction } from '$lib/client/socket';
	import { strings, roleName, presetName, formatSetupIssue } from '$lib/shared/i18n';
	import type { ValidationIssue } from '$lib/game/rules/setup';
	import { i18n } from '$lib/client/i18n.svelte';
	import type { AckResponse, RuleConfigOverrides } from '$lib/shared/events';
	import PixelSprite from './PixelSprite.svelte';

	const t = $derived(strings(i18n.lang));

	function issueText(i: ValidationIssue): string {
		const roleLabel = i.params?.roleId
			? roleName(roleIdToLegacy(i.params.roleId), i18n.lang)
			: undefined;
		return formatSetupIssue(i.code, i.reason, { ...i.params, roleLabel }, i18n.lang);
	}

	let counts = $state<Record<Role, number>>(
		Object.fromEntries(ALL_ROLES.map((r) => [r, 0])) as Record<Role, number>
	);
	let cupidPoisonBlocksHunter = $state(false);
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let issues = $state<string[]>([]);

	// Narrowed to the 15 roles the new engine can represent (M0 plan decision
	// 3) - the other 7 (禁言长老/高级村民/老流氓/隐狼/恶魔/机械狼/梦魇)
	// have no RoleId counterpart, so a room configured with one of them would
	// fail to start (server-side validated too, in handleRoomSubmitConfig).
	const pickableRoles = ALL_ROLES.filter((r) => SUPPORTED_LEGACY_ROLES.includes(r));
	const goodRoles = pickableRoles.filter((r) => roleTeam(r) === 'village');
	const wolfRoles = pickableRoles.filter((r) => roleTeam(r) === 'wolf');

	const total = $derived(Object.values(counts).reduce((s: number, n) => s + (n ?? 0), 0));
	const goodTotal = $derived(goodRoles.reduce((s, r) => s + (counts[r] ?? 0), 0));
	const wolfTotal = $derived(wolfRoles.reduce((s, r) => s + (counts[r] ?? 0), 0));

	function inc(role: Role, delta: number) {
		counts[role] = Math.max(0, (counts[role] ?? 0) + delta);
	}

	function applyPreset(roleConfig: Partial<Record<RoleId, number>>) {
		const next = Object.fromEntries(ALL_ROLES.map((r) => [r, 0])) as Record<Role, number>;
		for (const [roleId, count] of Object.entries(roleConfig) as [RoleId, number][]) {
			next[roleIdToLegacy(roleId)] = count ?? 0;
		}
		counts = next;
	}

	// §6 RuleConfig switches exposed on this screen (M2) - seeded from the
	// engine's own defaults so an untouched toggle reflects the real default,
	// not just whatever value happened to be written here first.
	const defaults = defaultRuleConfig();
	let winCondition = $state<'SIDE_KILL' | 'TOTAL_KILL'>(defaults.winCondition);
	let wolfAllowEmptyKill = $state(defaults.wolf.allowEmptyKill);
	let blackWolfKingCanShootWhenLoverSuicide = $state(
		defaults.wolf.blackWolfKingCanShootWhenLoverSuicide
	);
	let guardSameGuardSameSave = $state(defaults.guard.sameGuardSameSave);
	let witchSelfRescue = $state(defaults.witch.selfRescue);
	let witchCanPoisonSelf = $state(defaults.witch.canPoisonSelf);
	let witchBothPotionsSameNight = $state(defaults.witch.bothPotionsSameNight);
	let hunterCanShootWhenPoisoned = $state(defaults.hunter.canShootWhenPoisoned);
	let hunterCanShootWhenExiled = $state(defaults.hunter.canShootWhenExiled);
	let hunterCanShootWhenWolfKilled = $state(defaults.hunter.canShootWhenWolfKilled);
	let hunterCanShootWhenLoverSuicide = $state(defaults.hunter.canShootWhenLoverSuicide);
	let idiotRevealOnExile = $state(defaults.idiot.revealOnExile);
	let idiotKeepsSpeechRight = $state(defaults.idiot.keepsSpeechRight);
	let idiotLosesVoteRight = $state(defaults.idiot.losesVoteRight);
	let idiotCanRunForSheriffAfterReveal = $state(defaults.idiot.canRunForSheriffAfterReveal);
	let idiotTearsBadgeIfSheriff = $state(defaults.idiot.tearsBadgeIfSheriff);
	let idiotDiesNormallyAtNight = $state(defaults.idiot.diesNormallyAtNight);

	function buildRuleOverrides(): RuleConfigOverrides {
		return {
			winCondition,
			wolf: {
				allowEmptyKill: wolfAllowEmptyKill,
				blackWolfKingCanShootWhenLoverSuicide
			},
			guard: { sameGuardSameSave: guardSameGuardSameSave },
			witch: {
				selfRescue: witchSelfRescue,
				canPoisonSelf: witchCanPoisonSelf,
				bothPotionsSameNight: witchBothPotionsSameNight
			},
			hunter: {
				canShootWhenPoisoned: hunterCanShootWhenPoisoned,
				canShootWhenExiled: hunterCanShootWhenExiled,
				canShootWhenWolfKilled: hunterCanShootWhenWolfKilled,
				canShootWhenLoverSuicide: hunterCanShootWhenLoverSuicide
			},
			idiot: {
				revealOnExile: idiotRevealOnExile,
				keepsSpeechRight: idiotKeepsSpeechRight,
				losesVoteRight: idiotLosesVoteRight,
				canRunForSheriffAfterReveal: idiotCanRunForSheriffAfterReveal,
				tearsBadgeIfSheriff: idiotTearsBadgeIfSheriff,
				diesNormallyAtNight: idiotDiesNormallyAtNight
			}
		};
	}

	async function submit() {
		error = null;
		issues = [];
		if (total === 0) {
			error = t.roleConfig.atLeastOneRole;
			return;
		}
		submitting = true;
		const res = await sendAction<AckResponse & { issues?: ValidationIssue[] }>(
			{
				kind: 'RoomSubmitConfig',
				roleConfig: counts,
				cupidPoisonBlocksHunter,
				ruleOverrides: buildRuleOverrides()
			},
			{ quiet: true } // validation issues are listed inline below
		);
		submitting = false;
		if (!res.ok) {
			error = res.issues?.[0] ? issueText(res.issues[0]) : t.roleConfig.submitFailed;
			issues = (res.issues ?? []).map((i) => `${i.code} · ${issueText(i)}`);
		} else if (res.issues && res.issues.length > 0) {
			issues = res.issues.map((i) => `⚠ ${i.code} · ${issueText(i)}`);
		}
	}
</script>

{#snippet section(title: string, subtitle: string, roles: Role[], count: number, good: boolean)}
	<div class="panel p-3">
		<div
			class="mb-3 flex items-center justify-between border-[3px] border-line px-2 py-1.5 text-xs font-bold tracking-widest uppercase {good
				? 'bg-village text-black'
				: 'bg-wolf-deep text-bone'}"
		>
			<span>{good ? '☀' : '☾'} {title} · {subtitle}</span>
			<span class="tabular-nums">{count}</span>
		</div>
		<div class="grid grid-cols-2 gap-2">
			{#each roles as role, i (role)}
				<div
					in:fly={{ y: 10, duration: 200, delay: i * 25 }}
					class="flex items-center gap-2 border-[3px] border-line p-1.5 {(counts[role] ?? 0) > 0
						? 'bg-surface-2'
						: 'bg-surface'}"
				>
					<PixelSprite {role} px={30} idle={(counts[role] ?? 0) > 0} />
					<div class="min-w-0 flex-1">
						<div class="truncate text-[11px] text-bone">{roleName(role, i18n.lang)}</div>
					</div>
					<div class="flex items-center gap-1">
						<button
							onclick={() => inc(role, -1)}
							aria-label={t.roleConfig.decrease}
							class="h-6 w-6 border-2 border-line bg-line text-bone active:bg-ember active:text-black"
							>−</button
						>
						<span class="w-4 text-center text-sm text-village tabular-nums"
							>{counts[role] ?? 0}</span
						>
						<button
							onclick={() => inc(role, 1)}
							aria-label={t.roleConfig.increase}
							class="h-6 w-6 border-2 border-line bg-line text-bone active:bg-ember active:text-black"
							>+</button
						>
					</div>
				</div>
			{/each}
		</div>
	</div>
{/snippet}

{#snippet toggle(label: string, checked: boolean, onclick: () => void)}
	<button
		type="button"
		{onclick}
		class="flex w-full items-center gap-3 border-[3px] border-line p-2 text-left {checked
			? 'bg-surface-2'
			: 'bg-surface'}"
	>
		<span
			class="flex h-6 w-6 flex-none items-center justify-center border-2 border-line text-sm {checked
				? 'bg-ember text-black'
				: 'bg-line text-transparent'}">✓</span
		>
		<span class="text-[11px] leading-snug text-bone">{label}</span>
	</button>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col space-y-3">
	<h2 class="font-display text-lg font-semibold tracking-wider text-ember uppercase">
		{t.roleConfig.title}
	</h2>

	<div class="min-h-0 flex-1 space-y-3 overflow-y-auto">
		<div class="panel p-3">
			<div class="mb-2 text-xs font-bold tracking-widest text-ember uppercase">
				{t.roleConfig.presets}
			</div>
			<div class="flex flex-wrap gap-2">
				{#each PRESET_BOARDS as board (board.name)}
					<button
						type="button"
						onclick={() => applyPreset(board.roleConfig)}
						class="border-2 border-line bg-surface px-2 py-1 text-[11px] text-bone active:bg-ember active:text-black"
					>
						{presetName(board.name, i18n.lang)}
					</button>
				{/each}
			</div>
		</div>

		{@render section(t.roleConfig.goodCamp, 'Village', goodRoles, goodTotal, true)}
		{@render section(t.roleConfig.wolfCamp, 'Wolves', wolfRoles, wolfTotal, false)}

		<div class="panel space-y-3 p-3">
			<div class="text-xs font-bold tracking-widest text-ember uppercase">
				{t.roleConfig.houseRuleHeader}
			</div>

			{@render toggle(
				t.roleConfig.cupidPoisonBlocksHunter,
				cupidPoisonBlocksHunter,
				() => (cupidPoisonBlocksHunter = !cupidPoisonBlocksHunter)
			)}

			<div class="space-y-1.5 border-t-2 border-line/50 pt-2">
				<label class="flex items-center justify-between gap-2 text-[11px] text-bone">
					<span>{t.roleConfig.winConditionLabel}</span>
					<select
						bind:value={winCondition}
						class="border-2 border-line bg-surface px-2 py-1 text-[11px] text-bone"
					>
						<option value="SIDE_KILL">{t.roleConfig.winConditionSideKill}</option>
						<option value="TOTAL_KILL">{t.roleConfig.winConditionTotalKill}</option>
					</select>
				</label>
			</div>

			{@render toggle(
				t.roleConfig.wolfAllowEmptyKill,
				wolfAllowEmptyKill,
				() => (wolfAllowEmptyKill = !wolfAllowEmptyKill)
			)}

			<div class="space-y-1.5 border-t-2 border-line/50 pt-2">
				<label class="flex items-center justify-between gap-2 text-[11px] text-bone">
					<span>{t.roleConfig.sameGuardSameSaveLabel}</span>
					<select
						bind:value={guardSameGuardSameSave}
						class="border-2 border-line bg-surface px-2 py-1 text-[11px] text-bone"
					>
						<option value="TARGET_DIES">{t.roleConfig.sameGuardSameSaveDies}</option>
						<option value="TARGET_LIVES">{t.roleConfig.sameGuardSameSaveLives}</option>
					</select>
				</label>
			</div>

			<div class="space-y-1.5 border-t-2 border-line/50 pt-2">
				<div class="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
					{t.roleConfig.witchHeader}
				</div>
				<label class="flex items-center justify-between gap-2 text-[11px] text-bone">
					<span>{t.roleConfig.witchSelfRescueLabel}</span>
					<select
						bind:value={witchSelfRescue}
						class="border-2 border-line bg-surface px-2 py-1 text-[11px] text-bone"
					>
						<option value="FIRST_NIGHT_ONLY">{t.roleConfig.witchSelfRescueFirstNightOnly}</option>
						<option value="NEVER">{t.roleConfig.witchSelfRescueNever}</option>
						<option value="ALWAYS">{t.roleConfig.witchSelfRescueAlways}</option>
					</select>
				</label>
				{@render toggle(
					t.roleConfig.witchCanPoisonSelf,
					witchCanPoisonSelf,
					() => (witchCanPoisonSelf = !witchCanPoisonSelf)
				)}
				{@render toggle(
					t.roleConfig.witchBothPotionsSameNight,
					witchBothPotionsSameNight,
					() => (witchBothPotionsSameNight = !witchBothPotionsSameNight)
				)}
			</div>

			<div class="space-y-1.5 border-t-2 border-line/50 pt-2">
				<div class="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
					{t.roleConfig.hunterHeader}
				</div>
				{@render toggle(
					t.roleConfig.hunterCanShootWhenPoisoned,
					hunterCanShootWhenPoisoned,
					() => (hunterCanShootWhenPoisoned = !hunterCanShootWhenPoisoned)
				)}
				{@render toggle(
					t.roleConfig.hunterCanShootWhenExiled,
					hunterCanShootWhenExiled,
					() => (hunterCanShootWhenExiled = !hunterCanShootWhenExiled)
				)}
				{@render toggle(
					t.roleConfig.hunterCanShootWhenWolfKilled,
					hunterCanShootWhenWolfKilled,
					() => (hunterCanShootWhenWolfKilled = !hunterCanShootWhenWolfKilled)
				)}
				{@render toggle(
					t.roleConfig.hunterCanShootWhenLoverSuicide,
					hunterCanShootWhenLoverSuicide,
					() => (hunterCanShootWhenLoverSuicide = !hunterCanShootWhenLoverSuicide)
				)}
			</div>

			{#if (counts['黑狼王'] ?? 0) > 0}
				<div class="space-y-1.5 border-t-2 border-line/50 pt-2">
					<div class="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
						{t.roleConfig.blackWolfKingHeader}
					</div>
					{@render toggle(
						t.roleConfig.blackWolfKingCanShootWhenLoverSuicide,
						blackWolfKingCanShootWhenLoverSuicide,
						() => (blackWolfKingCanShootWhenLoverSuicide = !blackWolfKingCanShootWhenLoverSuicide)
					)}
				</div>
			{/if}

			<div class="space-y-1.5 border-t-2 border-line/50 pt-2">
				<div class="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
					{t.roleConfig.idiotHeader}
				</div>
				{@render toggle(
					t.roleConfig.idiotRevealOnExile,
					idiotRevealOnExile,
					() => (idiotRevealOnExile = !idiotRevealOnExile)
				)}
				{@render toggle(
					t.roleConfig.idiotKeepsSpeechRight,
					idiotKeepsSpeechRight,
					() => (idiotKeepsSpeechRight = !idiotKeepsSpeechRight)
				)}
				{@render toggle(
					t.roleConfig.idiotLosesVoteRight,
					idiotLosesVoteRight,
					() => (idiotLosesVoteRight = !idiotLosesVoteRight)
				)}
				{@render toggle(
					t.roleConfig.idiotCanRunForSheriffAfterReveal,
					idiotCanRunForSheriffAfterReveal,
					() => (idiotCanRunForSheriffAfterReveal = !idiotCanRunForSheriffAfterReveal)
				)}
				{@render toggle(
					t.roleConfig.idiotTearsBadgeIfSheriff,
					idiotTearsBadgeIfSheriff,
					() => (idiotTearsBadgeIfSheriff = !idiotTearsBadgeIfSheriff)
				)}
				{@render toggle(
					t.roleConfig.idiotDiesNormallyAtNight,
					idiotDiesNormallyAtNight,
					() => (idiotDiesNormallyAtNight = !idiotDiesNormallyAtNight)
				)}
			</div>
		</div>

		{#if issues.length > 0}
			<div class="panel space-y-1 p-3">
				{#each issues as msg (msg)}
					<p class="text-[11px] text-zinc-400">{msg}</p>
				{/each}
			</div>
		{/if}
	</div>

	<!-- The role list above is flex-1 (fills all leftover space itself, with
	     its own internal scroll), so this just naturally lands at the true
	     bottom as a normal shrink-0 flex item - no mt-auto/sticky needed, and
	     no big empty gap either since the list absorbs the slack instead of
	     leaving it blank. Border-t + bg-ink/95 matches the page's own pinned
	     footer styling elsewhere in the room. -->
	<div class="shrink-0 space-y-2 border-t-[3px] border-line bg-ink/95 px-1 py-2">
		<p class="text-sm text-zinc-500">
			{(counts['盗贼'] ?? 0) > 0
				? t.roleConfig.cardCountWithThief(total, total - 2)
				: t.roleConfig.cardCountSummary(total)}
		</p>
		{#if error}<p class="text-sm text-wolf">{error}</p>{/if}
		<button onclick={submit} disabled={submitting} class="btn-primary w-full">
			{submitting ? t.roleConfig.submitting : t.roleConfig.confirm}
		</button>
	</div>
</div>
