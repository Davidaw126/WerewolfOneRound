import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { socketIODevPlugin } from './src/lib/server/socket/devPlugin';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// adapter-node: we need a bare Node HTTP server to attach Socket.IO to,
			// which adapter-auto's target environments don't reliably expose.
			adapter: adapter(),

			// SvelteKit nonces its own inline hydration bootstrap script
			// automatically (mode 'auto' -> nonce for dynamically-rendered pages,
			// which is all of them here - nothing is prerendered), so script-src
			// stays nonce-only with no 'unsafe-inline'/'unsafe-eval'. style-src
			// needs 'unsafe-inline' because Svelte's built-in transitions
			// (in:scale/in:fade, used throughout src/lib/components) inject
			// inline <style> elements at runtime that SvelteKit's own nonce can't
			// reach, and several components (SeatCircle, PixelSprite, the room
			// page) set inline style="..." attributes for computed positioning -
			// per SvelteKit's own CSP docs, that combination leaves 'unsafe-inline'
			// as the only non-breaking option for styles. fonts.googleapis.com/
			// gstatic.com are the Noto Serif SC webfont loaded in app.html.
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline', 'https://fonts.googleapis.com'],
					'font-src': ['self', 'https://fonts.gstatic.com'],
					'img-src': ['self', 'data:'],
					'connect-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['self'],
					'form-action': ['self'],
					'frame-ancestors': ['none']
				}
			}
		}),
		socketIODevPlugin()
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
