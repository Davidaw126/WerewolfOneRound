<script lang="ts">
	import { enhance } from '$app/forms';
	import { strings } from '$lib/shared/i18n';
	import { i18n } from '$lib/client/i18n.svelte';
	import LanguageToggle from '$lib/components/LanguageToggle.svelte';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
	const t = $derived(strings(i18n.lang));
	let submitting = $state(false);
</script>

<svelte:head>
	<title>{t.register.title}</title>
</svelte:head>

<div class="flex min-h-dvh flex-col items-center justify-center px-6 text-zinc-100">
	<div class="absolute top-4 right-4">
		<LanguageToggle />
	</div>
	<div class="w-full max-w-sm">
		<div class="mb-8 text-center">
			<h1 class="title-glow font-display text-5xl font-black tracking-wide text-wolf">
				{t.lobby.title}
			</h1>
			<p class="mt-2 text-sm tracking-widest text-zinc-500">{t.register.subtitle}</p>
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
			<input type="hidden" name="lang" value={i18n.lang} />
			<label for="username" class="mb-2 block text-sm font-medium text-zinc-300"
				>{t.register.usernameLabel}</label
			>
			<input
				id="username"
				name="username"
				type="text"
				autocomplete="off"
				maxlength="20"
				placeholder={t.register.usernamePlaceholder}
				class="w-full rounded-lg border border-white/10 bg-ink px-4 py-3 text-base text-zinc-100 placeholder:text-zinc-600 focus:border-ember focus:ring-2 focus:ring-ember/40 focus:outline-none"
			/>

			{#if form?.error}
				<p class="mt-2 text-sm text-wolf">{form.error}</p>
			{/if}

			<button type="submit" disabled={submitting} class="btn-primary mt-5 w-full text-base">
				{submitting ? t.register.submitting : t.register.submit}
			</button>
		</form>
	</div>
</div>
