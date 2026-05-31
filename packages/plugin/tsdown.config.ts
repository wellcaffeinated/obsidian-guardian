import { copyFile } from 'node:fs/promises'
import { defineConfig } from 'tsdown'

/**
 * Obsidian loads a plugin as a single CommonJS `main.js` alongside its
 * `manifest.json` (+ optional `styles.css`). So: bundle everything (engine,
 * isomorphic-git, …) except the ambient `obsidian`/`electron` runtimes and node
 * builtins (which resolve to Electron's Node on desktop — hence isDesktopOnly),
 * emit CJS as `main.js`, and copy the manifest + styles next to it so `dist/`
 * is a drop-in plugin folder.
 */
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['cjs'],
  platform: 'node',
  outDir: 'dist',
  outExtensions: () => ({ js: '.js' }),
  sourcemap: true,
  clean: true,
  dts: false,
  deps: {
    alwaysBundle: [/.*/],
    neverBundle: ['obsidian', 'electron'],
  },
  hooks: {
    'build:done': async () => {
      await copyFile('manifest.json', 'dist/manifest.json')
      await copyFile('styles.css', 'dist/styles.css')
    },
  },
})
