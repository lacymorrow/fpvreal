import { resolve } from 'node:path';

export default {
	server: { port: 5173 },
	// Rapier ships as wasm; keeping it unbundled in dev avoids a re-optimise loop.
	optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
	build: {
		target: 'es2022',
		rollupOptions: {
			input: {
				main: resolve(import.meta.dirname, 'index.html'),
				latency: resolve(import.meta.dirname, 'latency.html'),
			},
			output: {
				manualChunks: { three: ['three'] },
			},
		},
		reportCompressedSize: false,
	},
};
