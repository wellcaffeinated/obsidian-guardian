import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Test against the engine source for fast iteration, mirroring the cli
      // package. Build + typecheck verify the artifact separately.
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
