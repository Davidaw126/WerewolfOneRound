<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
	let submitting = $state(false);
</script>

<svelte:head>
	<title>狼人杀助手</title>
</svelte:head>

<div class="flex min-h-dvh flex-col items-center justify-center px-6 text-zinc-100">
	<div class="w-full max-w-sm">
		<div class="mb-8 text-center">
			<h1 class="title-glow font-display text-5xl font-black tracking-wide text-wolf">狼人杀</h1>
			<p class="mt-2 text-sm tracking-widest text-zinc-500">法官助手 · Werewolf Judge Helper</p>
		</div>

		<form
			method="POST"
			class="panel p-6"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
		>
			<label for="username" class="mb-2 block text-sm font-medium text-zinc-300">用户名</label>
			<input
				id="username"
				name="username"
				type="text"
				autocomplete="off"
				maxlength="20"
				placeholder="给自己起个名字"
				class="w-full rounded-lg border border-white/10 bg-ink px-4 py-3 text-base text-zinc-100 placeholder:text-zinc-600 focus:border-ember focus:ring-2 focus:ring-ember/40 focus:outline-none"
			/>

			{#if form?.error}
				<p class="mt-2 text-sm text-wolf">{form.error}</p>
			{/if}

			<button type="submit" disabled={submitting} class="btn-primary mt-5 w-full text-base">
				{submitting ? '进入中…' : '进入游戏'}
			</button>
		</form>
	</div>
</div>
