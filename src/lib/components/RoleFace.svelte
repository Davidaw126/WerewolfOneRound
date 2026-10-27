<script lang="ts">
	import { roleTeam } from '$lib/shared/roles';
	import type { RoleId } from '$lib/game/types';
	import { roleName, roleFlavor, campName, campNameShort } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';
	import PixelSprite from './PixelSprite.svelte';

	let {
		role,
		size = 'lg',
		showTeam = true
	}: { role: RoleId; size?: 'lg' | 'sm'; showTeam?: boolean } = $props();

	const team = $derived(roleTeam(role));
</script>

<div
	class="role-frame w-full {team === 'wolf' ? 'role-frame--wolf' : 'role-frame--village'} {size ===
	'lg'
		? 'gap-2 px-6 py-6'
		: 'gap-1 px-2 py-3'}"
>
	<PixelSprite {role} px={size === 'lg' ? 88 : 44} />
	<div
		class="font-display font-bold {team === 'wolf' ? 'text-wolf' : 'text-village'} {size === 'lg'
			? 'text-2xl'
			: 'text-sm'}"
	>
		{roleName(role, i18n.lang)}
	</div>
	{#if size === 'lg'}
		{#if showTeam}
			<div class="text-xs tracking-widest text-zinc-500 uppercase">
				{campName(team, i18n.lang)}
			</div>
		{/if}
		<div class="mt-1 text-sm text-zinc-400">
			『{roleFlavor(role, i18n.lang)}』
		</div>
	{:else if showTeam}
		<div class="text-[10px] tracking-wide text-zinc-500 uppercase">
			{campNameShort(team, i18n.lang)}
		</div>
	{/if}
</div>
