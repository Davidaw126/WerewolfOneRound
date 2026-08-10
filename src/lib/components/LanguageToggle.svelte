<script lang="ts">
	import { i18n } from '$lib/client/i18n.svelte';

	function toggle() {
		i18n.setLang(i18n.lang === 'zh' ? 'en' : 'zh');
	}
</script>

<button
	onclick={toggle}
	aria-label={i18n.lang === 'zh' ? 'Switch to English' : '切换到中文'}
	title={i18n.lang === 'zh' ? 'Switch to English' : '切换到中文'}
	class="rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-bold tracking-wide text-zinc-400 transition hover:border-ember/60 hover:text-ember"
>
	{i18n.lang === 'zh' ? 'EN' : '中文'}
</button>
