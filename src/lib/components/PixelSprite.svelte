<script lang="ts">
	import type { Role } from '$lib/shared/roles';
	import { PAL, spriteFor } from '$lib/shared/roleSprites';

	let { role, px = 48, idle = true }: { role: Role; px?: number; idle?: boolean } = $props();

	let canvas: HTMLCanvasElement | undefined = $state();

	$effect(() => {
		if (!canvas) return;
		const rows = spriteFor(role);
		const N = 16;
		canvas.width = N;
		canvas.height = N;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.clearRect(0, 0, N, N);
		for (let y = 0; y < rows.length && y < N; y++) {
			const row = rows[y];
			for (let x = 0; x < row.length && x < N; x++) {
				const col = PAL[row[x]];
				if (col) {
					ctx.fillStyle = col;
					ctx.fillRect(x, y, 1, 1);
				}
			}
		}
	});
</script>

<canvas
	bind:this={canvas}
	class="pixelated {idle ? 'idle' : ''}"
	style="width:{px}px;height:{px}px"
	aria-hidden="true"
></canvas>

<style>
	canvas {
		display: block;
	}
	.idle {
		animation: bob 1.4s steps(2) infinite;
	}
	@keyframes bob {
		0%,
		100% {
			transform: translateY(0);
		}
		50% {
			transform: translateY(-2px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.idle {
			animation: none;
		}
	}
</style>
