import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Test against source for a fast iteration loop. The published artifact
      // is verified separately by `build` + `typecheck`.
      '@obsidian-bedrock/engine': new URL('./src/index.ts', import.meta.url)
        .pathname,
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
})
