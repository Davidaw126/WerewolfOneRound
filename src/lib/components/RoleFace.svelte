<script lang="ts">
	import { roleTeam, type Role } from '$lib/shared/roles';
	import { ROLE_FLAVOR } from '$lib/shared/roleFlavor';
	import PixelSprite from './PixelSprite.svelte';

	let {
		role,
		size = 'lg',
		showTeam = true
	}: { role: Role; size?: 'lg' | 'sm'; showTeam?: boolean } = $props();

	const team = $derived(roleTeam(role));
</script>

<div
	class="role-frame h-full w-full {team === 'wolf'
		? 'role-frame--wolf'
		: 'role-frame--village'} {size === 'lg' ? 'gap-2 px-6 py-6' : 'gap-1 px-2 py-3'}"
>
	<PixelSprite {role} px={size === 'lg' ? 88 : 44} />
	<div
		class="font-display font-bold {team === 'wolf' ? 'text-wolf' : 'text-village'} {size === 'lg'
			? 'text-2xl'
			: 'text-sm'}"
	>
		{role}
	</div>
	{#if size === 'lg'}
		{#if showTeam}
			<div class="text-xs tracking-widest text-zinc-500 uppercase">
				{team === 'wolf' ? '狼人阵营' : '好人阵营'}
			</div>
		{/if}
		<div class="mt-1 text-sm text-zinc-400">『{ROLE_FLAVOR[role]}』</div>
	{:else if showTeam}
		<div class="text-[10px] tracking-wide text-zinc-500 uppercase">
			{team === 'wolf' ? '狼人' : '好人'}
		</div>
	{/if}
</div>
