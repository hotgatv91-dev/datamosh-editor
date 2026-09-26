import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SharedArrayBuffer (and therefore a multi-threaded ffmpeg core later on) requires
// cross-origin isolation. We set it for dev + preview so the capability check in
// engine/export is meaningful on localhost too.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: '/datamosh-editor/',
  plugins: [react()],
  optimizeDeps: {
    // @ffmpeg/ffmpeg spawns its own module worker and @ffmpeg/core resolves its
    // wasm through an exports map; esbuild pre-bundling breaks both.
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/core', '@ffmpeg/util'],
  },
  server: {
    port: 5180,
    headers: isolationHeaders,
  },
  preview: {
    port: 5180,
    headers: isolationHeaders,
  },
  worker: {
    format: 'es',
  },
  build: {
    // The single-threaded ffmpeg core wasm is ~25 MB. It is lazily imported,
    // so it stays out of the initial bundle, but Vite still needs to be told
    // not to inline/choke on it.
    chunkSizeWarningLimit: 32 * 1024,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor-react';
          }
          if (id.includes('@ffmpeg/ffmpeg') || id.includes('@ffmpeg/util')) {
            return 'vendor-ffmpeg';
          }
        },
      },
    },
  },
});
