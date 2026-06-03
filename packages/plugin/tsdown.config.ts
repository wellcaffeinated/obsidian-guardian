import { copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { defineConfig } from 'tsdown'

/** The feross `buffer` polyfill's actual file. `safe-buffer` (an isomorphic-git
 * transitive dep) does `require('buffer')` at build time — which `platform:'node'`
 * would externalise to the Node builtin, unavailable in the mobile WKWebView.
 * Aliasing `buffer` to this file bundles the polyfill instead, on every target.
 * (isomorphic-git's *free* `Buffer` global is handled separately — `main.ts`
 * sets `globalThis.Buffer` from the bundled polyfill at load.) */
const bufferPolyfillFile = createRequire(import.meta.url).resolve(
  'buffer/index.js',
)

/** Auto-generated per build: `build-YYYYMMDD-HHMM` (local time). Inlined into
 * the bundle via `define` and shown muted at the foot of the review panel. */
function buildId(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `build-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

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
  define: {
    __OG_BUILD__: JSON.stringify(buildId()),
  },
  // Make `Buffer` resolvable on mobile (the WKWebView has no Node `Buffer`):
  // alias `buffer` to the bundled feross file so safe-buffer's
  // `require('buffer')` isn't externalised to the (mobile-absent) Node builtin.
  // (iso-git's *free* `Buffer` global is set on `globalThis` in `main.ts`.)
  // Function form so tsdown merges rather than drops the option.
  inputOptions(options) {
    options.resolve = {
      ...options.resolve,
      alias: { ...options.resolve?.alias, buffer: bufferPolyfillFile },
    }
    return options
  },
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
