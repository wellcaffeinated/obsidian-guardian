import { copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join as joinPath } from 'node:path'
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

/** Absolute path to `pathe` (browser-safe `node:path`). Aliased by absolute path
 * — a bare `'pathe'` specifier can't resolve from the engine package under
 * pnpm's strict isolation (pathe is a plugin dependency). */
const pathePolyfillFile = createRequire(import.meta.url).resolve('pathe')

/** Absolute path to isomorphic-git's **ESM build** (`index.js`). Its `node`
 * export condition (`index.cjs`) does `require('crypto')`/`require('fs')` at
 * module top — fatal on mobile, where iso-git is loaded eagerly by the engine.
 * The ESM build uses Web Crypto + the injected fs instead, so aliasing to it
 * removes those node-builtin requires on every target (Electron has Web Crypto
 * too). The desktop live smoke exercises this build end-to-end. */
// `index.js` isn't an exposed subpath in iso-git's `exports`, so resolve the
// package dir (via its node entry) and join the ESM file directly.
const isomorphicGitEsm = joinPath(
  dirname(createRequire(import.meta.url).resolve('isomorphic-git')),
  'index.js',
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
  // Mobile load-safety: the WebView has no Node builtins. Two aliases bundle
  // browser-safe implementations so they aren't externalised to `require(...)`
  // (which throws at load on mobile). Function form so tsdown merges, not drops.
  //  - `buffer` → the feross polyfill file, so safe-buffer's `require('buffer')`
  //    bundles in (iso-git's *free* `Buffer` global is set in `main.ts`).
  //  - `node:path`/`path` → `pathe` (pure JS, posix), used by the engine + config
  //    on both platforms. Desktop-only `node:fs`/`node:os` stay un-aliased —
  //    they live in `desktop-env.ts`, dynamically imported on the desktop branch
  //    only, so their requires never run at load on mobile.
  inputOptions(options) {
    options.resolve = {
      ...options.resolve,
      alias: {
        ...options.resolve?.alias,
        buffer: bufferPolyfillFile,
        'node:path': pathePolyfillFile,
        path: pathePolyfillFile,
        'isomorphic-git': isomorphicGitEsm,
      },
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
