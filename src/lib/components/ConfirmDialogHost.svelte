<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { confirmDialogStore } from '$lib/client/confirmDialog.svelte';
</script>

{#if confirmDialogStore.open}
	<div
		class="overlay-backdrop"
		role="presentation"
		onclick={() => confirmDialogStore.respond(false)}
		transition:fade={{ duration: 150 }}
	>
		<div
			class="overlay-panel panel p-4"
			role="dialog"
			aria-modal="true"
			aria-label="确认"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			transition:scale={{ duration: 200, start: 0.85 }}
		>
			<p class="mb-4 text-sm text-bone">{confirmDialogStore.message}</p>
			<div class="flex gap-2">
				{#if confirmDialogStore.cancelLabel !== null}
					<button onclick={() => confirmDialogStore.respond(false)} class="btn-ghost flex-1">
						{confirmDialogStore.cancelLabel}
					</button>
				{/if}
				<button onclick={() => confirmDialogStore.respond(true)} class="btn-danger flex-1">
					{confirmDialogStore.confirmLabel}
				</button>
			</div>
		</div>
	</div>
{/if}
