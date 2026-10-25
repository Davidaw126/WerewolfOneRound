<script lang="ts">
	import { gameStore } from '$lib/client/gameStore.svelte';

	type TimeOfDay = 'night' | 'day' | null;

	const timeOfDay = $derived.by<TimeOfDay>(() => {
		switch (gameStore.state?.phase) {
			case 'NIGHT_ACTIONS':
			case 'NIGHT_HUNTER_SHOT':
				return 'night';
			case 'DAY_VOTE':
			case 'DAY_HUNTER_SHOT':
				return 'day';
			default:
				return null;
		}
	});

	// Purely visual and runs on every client. The host-only JudgeAudioPlayer
	// fires 天黑/天亮 off the same phase change, so audio + this overlay stay in
	// sync on the host device without either knowing about the other.
	let active = $state<TimeOfDay>(null);
	let prev: TimeOfDay = null;
	let timer: ReturnType<typeof setTimeout>;

	$effect(() => {
		const now = timeOfDay;
		if (now !== null && now !== prev) {
			active = now;
			clearTimeout(timer);
			timer = setTimeout(() => (active = null), 1400);
		}
		prev = now;
	});
</script>

{#if active}
	<div class="sweep sweep-{active}" aria-hidden="true">
		<div class="disc">{active === 'night' ? '🌙' : '☀️'}</div>
	</div>
{/if}

<style>
	.sweep {
		position: fixed;
		inset: 0;
		z-index: 40;
		pointer-events: none;
		display: flex;
		align-items: center;
		justify-content: center;
		animation: wash 1.4s ease-in-out forwards;
	}
	.sweep-night {
		background: radial-gradient(circle at 50% 40%, rgba(49, 46, 129, 0.85), rgba(0, 0, 0, 0.95));
	}
	.sweep-day {
		background: radial-gradient(circle at 50% 40%, rgba(245, 200, 120, 0.7), rgba(8, 8, 10, 0.9));
	}
	.disc {
		font-size: 5rem;
		animation: rise 1.4s ease-in-out forwards;
	}
	@keyframes wash {
		0% {
			opacity: 0;
		}
		25% {
			opacity: 1;
		}
		75% {
			opacity: 1;
		}
		100% {
			opacity: 0;
		}
	}
	@keyframes rise {
		0% {
			transform: translateY(40px) scale(0.6);
			opacity: 0;
		}
		30% {
			opacity: 1;
		}
		100% {
			transform: translateY(-10px) scale(1);
			opacity: 0.9;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.disc {
			animation: none;
		}
	}
</style>
