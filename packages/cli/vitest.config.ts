import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Test against the engine source (and our own src) for fast iteration,
      // mirroring the engine package. Build + typecheck verify the artifact.
      '@obsidian-guardian/engine': new URL(
        '../engine/src/index.ts',
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
})
