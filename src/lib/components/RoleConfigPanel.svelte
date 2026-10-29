<script lang="ts">
	import { fly } from 'svelte/transition';
	import { PICKABLE_ROLES, roleTeam } from '$lib/shared/roles';
	import { ALL_ROLE_IDS } from '$lib/game/roleMeta';
	import { PRESET_BOARDS } from '$lib/game/rules/presets';
	import { defaultRuleConfig } from '$lib/game/defaultRuleConfig';
	import { switchesOf } from '$lib/game/ruleSwitchValues';
	import type { RoleId } from '$lib/game/types';
	import { sendAction } from '$lib/client/socket';
	import { strings, roleName, presetName, formatSetupIssue } from '$lib/shared/i18n';
	import type { ValidationIssue } from '$lib/game/rules/setup';
	import { i18n } from '$lib/client/i18n.svelte';
	import PixelSprite from './PixelSprite.svelte';

	const t = $derived(strings(i18n.lang));

	const issueText = (i: ValidationIssue) => formatSetupIssue(i, i18n.lang);

	const noRoles = () =>
		Object.fromEntries(ALL_ROLE_IDS.map((r) => [r, 0])) as Record<RoleId, number>;
	let counts = $state<Record<RoleId, number>>(noRoles());
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let issues = $state<string[]>([]);

	const goodRoles = PICKABLE_ROLES.filter((r) => roleTeam(r) === 'village');
	const wolfRoles = PICKABLE_ROLES.filter((r) => roleTeam(r) === 'wolf');

	const total = $derived(Object.values(counts).reduce((s: number, n) => s + (n ?? 0), 0));
	const goodTotal = $derived(goodRoles.reduce((s, r) => s + (counts[r] ?? 0), 0));
	const wolfTotal = $derived(wolfRoles.reduce((s, r) => s + (counts[r] ?? 0), 0));

	function inc(role: RoleId, delta: number) {
		counts[role] = Math.max(0, (counts[role] ?? 0) + delta);
	}

	function applyPreset(roleConfig: Partial<Record<RoleId, number>>) {
		const next = noRoles();
		for (const [roleId, count] of Object.entries(roleConfig) as [RoleId, number][]) {
			next[roleId] = count ?? 0;
		}
		counts = next;
	}

	// The Host's rule switches, starting from the engine's own defaults so an
	// untouched toggle shows the real default.
	const rules = $state(switchesOf(defaultRuleConfig()));

	async function submit() {
		error = null;
		issues = [];
		if (total === 0) {
			error = t.roleConfig.atLeastOneRole;
			return;
		}
		submitting = true;
		const res = await sendAction(
			{
				kind: 'RoomSubmitConfig',
				roleConfig: counts,
				ruleOverrides: rules
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

{#snippet section(
	title: string,
	subtitle: string,
	roles: readonly RoleId[],
	count: number,
	good: boolean
)}
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
				<!-- Sprite + name on top, the −/+ row underneath at the card's full
				     width: beside the sprite it only gets ~69px on a 320px phone and
				     the 32px buttons get squeezed. -->
				<div
					in:fly={{ y: 10, duration: 200, delay: i * 25 }}
					class="border-[3px] border-line p-1.5 {(counts[role] ?? 0) > 0
						? 'bg-surface-2'
						: 'bg-surface'}"
				>
					<div class="flex items-center gap-2">
						<PixelSprite {role} px={30} idle={(counts[role] ?? 0) > 0} />
						<div class="min-w-0 flex-1 truncate text-xs text-bone">{roleName(role, i18n.lang)}</div>
					</div>
					<div class="mt-1 flex items-center justify-center gap-1">
						<button
							onclick={() => inc(role, -1)}
							aria-label={t.roleConfig.decrease}
							class="h-8 w-8 shrink-0 border-2 border-line bg-line text-bone active:bg-ember active:text-black"
							>−</button
						>
						<span class="w-5 text-center text-sm text-village tabular-nums"
							>{counts[role] ?? 0}</span
						>
						<button
							onclick={() => inc(role, 1)}
							aria-label={t.roleConfig.increase}
							class="h-8 w-8 shrink-0 border-2 border-line bg-line text-bone active:bg-ember active:text-black"
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

<div class="flex min-h-0 flex-1 flex-col space-y-2">
	<h2 class="font-display text-sm font-semibold tracking-wider text-ember uppercase">
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
				rules.cupidPoisonBlocksHunter,
				() => (rules.cupidPoisonBlocksHunter = !rules.cupidPoisonBlocksHunter)
			)}

			<div class="space-y-1.5 border-t-2 border-line/50 pt-2">
				<label class="flex items-center justify-between gap-2 text-[11px] text-bone">
					<span>{t.roleConfig.winConditionLabel}</span>
					<select
						bind:value={rules.winCondition}
						class="border-2 border-line bg-surface px-2 py-1 text-[11px] text-bone"
					>
						<option value="SIDE_KILL">{t.roleConfig.winConditionSideKill}</option>
						<option value="TOTAL_KILL">{t.roleConfig.winConditionTotalKill}</option>
					</select>
				</label>
			</div>

			{@render toggle(
				t.roleConfig.wolfAllowEmptyKill,
				rules.wolf.allowEmptyKill,
				() => (rules.wolf.allowEmptyKill = !rules.wolf.allowEmptyKill)
			)}

			<div class="space-y-1.5 border-t-2 border-line/50 pt-2">
				<label class="flex items-center justify-between gap-2 text-[11px] text-bone">
					<span>{t.roleConfig.sameGuardSameSaveLabel}</span>
					<select
						bind:value={rules.guard.sameGuardSameSave}
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
						bind:value={rules.witch.selfRescue}
						class="border-2 border-line bg-surface px-2 py-1 text-[11px] text-bone"
					>
						<option value="FIRST_NIGHT_ONLY">{t.roleConfig.witchSelfRescueFirstNightOnly}</option>
						<option value="NEVER">{t.roleConfig.witchSelfRescueNever}</option>
						<option value="ALWAYS">{t.roleConfig.witchSelfRescueAlways}</option>
					</select>
				</label>
				{@render toggle(
					t.roleConfig.witchCanPoisonSelf,
					rules.witch.canPoisonSelf,
					() => (rules.witch.canPoisonSelf = !rules.witch.canPoisonSelf)
				)}
				{@render toggle(
					t.roleConfig.witchBothPotionsSameNight,
					rules.witch.bothPotionsSameNight,
					() => (rules.witch.bothPotionsSameNight = !rules.witch.bothPotionsSameNight)
				)}
			</div>

			<div class="space-y-1.5 border-t-2 border-line/50 pt-2">
				<div class="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
					{t.roleConfig.hunterHeader}
				</div>
				{@render toggle(
					t.roleConfig.hunterCanShootWhenPoisoned,
					rules.hunter.canShootWhenPoisoned,
					() => (rules.hunter.canShootWhenPoisoned = !rules.hunter.canShootWhenPoisoned)
				)}
				{@render toggle(
					t.roleConfig.hunterCanShootWhenExiled,
					rules.hunter.canShootWhenExiled,
					() => (rules.hunter.canShootWhenExiled = !rules.hunter.canShootWhenExiled)
				)}
				{@render toggle(
					t.roleConfig.hunterCanShootWhenWolfKilled,
					rules.hunter.canShootWhenWolfKilled,
					() => (rules.hunter.canShootWhenWolfKilled = !rules.hunter.canShootWhenWolfKilled)
				)}
				{@render toggle(
					t.roleConfig.hunterCanShootWhenLoverSuicide,
					rules.hunter.canShootWhenLoverSuicide,
					() => (rules.hunter.canShootWhenLoverSuicide = !rules.hunter.canShootWhenLoverSuicide)
				)}
			</div>

			{#if (counts['BLACK_WOLF_KING'] ?? 0) > 0}
				<div class="space-y-1.5 border-t-2 border-line/50 pt-2">
					<div class="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
						{t.roleConfig.blackWolfKingHeader}
					</div>
					{@render toggle(
						t.roleConfig.blackWolfKingCanShootWhenLoverSuicide,
						rules.wolf.blackWolfKingCanShootWhenLoverSuicide,
						() =>
							(rules.wolf.blackWolfKingCanShootWhenLoverSuicide =
								!rules.wolf.blackWolfKingCanShootWhenLoverSuicide)
					)}
				</div>
			{/if}

			<div class="space-y-1.5 border-t-2 border-line/50 pt-2">
				<div class="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
					{t.roleConfig.idiotHeader}
				</div>
				{@render toggle(
					t.roleConfig.idiotRevealOnExile,
					rules.idiot.revealOnExile,
					() => (rules.idiot.revealOnExile = !rules.idiot.revealOnExile)
				)}
				{@render toggle(
					t.roleConfig.idiotKeepsSpeechRight,
					rules.idiot.keepsSpeechRight,
					() => (rules.idiot.keepsSpeechRight = !rules.idiot.keepsSpeechRight)
				)}
				{@render toggle(
					t.roleConfig.idiotLosesVoteRight,
					rules.idiot.losesVoteRight,
					() => (rules.idiot.losesVoteRight = !rules.idiot.losesVoteRight)
				)}
				{@render toggle(
					t.roleConfig.idiotCanRunForSheriffAfterReveal,
					rules.idiot.canRunForSheriffAfterReveal,
					() => (rules.idiot.canRunForSheriffAfterReveal = !rules.idiot.canRunForSheriffAfterReveal)
				)}
				{@render toggle(
					t.roleConfig.idiotTearsBadgeIfSheriff,
					rules.idiot.tearsBadgeIfSheriff,
					() => (rules.idiot.tearsBadgeIfSheriff = !rules.idiot.tearsBadgeIfSheriff)
				)}
				{@render toggle(
					t.roleConfig.idiotDiesNormallyAtNight,
					rules.idiot.diesNormallyAtNight,
					() => (rules.idiot.diesNormallyAtNight = !rules.idiot.diesNormallyAtNight)
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
	<div class="shrink-0 space-y-1 border-t-[3px] border-line bg-ink/95 px-1 py-2">
		{#if error}<p class="text-xs text-wolf">{error}</p>{/if}
		<!-- One row (count beside the button) to leave the role list more height. -->
		<div class="flex items-center gap-3">
			<p class="min-w-0 flex-1 text-xs leading-snug text-zinc-500">
				{(counts['THIEF'] ?? 0) > 0
					? t.roleConfig.cardCountWithThief(total, total - 2)
					: t.roleConfig.cardCountSummary(total)}
			</p>
			<button onclick={submit} disabled={submitting} class="btn-primary shrink-0 py-2">
				{submitting ? t.roleConfig.submitting : t.roleConfig.confirm}
			</button>
		</div>
	</div>
</div>
