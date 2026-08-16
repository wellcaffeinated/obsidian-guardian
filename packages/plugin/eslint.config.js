import obsidianmd from 'eslint-plugin-obsidianmd'
import tseslint from 'typescript-eslint'

/**
 * A second, deliberately narrow linter. Biome (repo root) owns general JS/TS
 * hygiene and all formatting; this config exists only for the rules Biome
 * cannot have — ones that know the `obsidian` API surface (e.g. preferring
 * `FileManager.trashFile` over `vault.delete` so deletions respect the user's
 * trash preference) and the plugin manifest's shape.
 *
 * Scoped to this package on purpose: `packages/engine` is `obsidian`-free by
 * invariant, so these rules have nothing to say there. It also runs with this
 * package as cwd, because the plugin reads `manifest.json` relative to it.
 *
 * Run it with `--max-warnings 0` (as CI does): every rule left on below is one
 * we intend to obey, so a warning is a finding, not background noise.
 */
export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  ...obsidianmd.configs.recommended,
  {
    // The plugin's recommended config bundles typescript-eslint's own rule sets.
    // Those overlap Biome (which already runs over every package) and disagree
    // with deliberate choices here — the guarded `require()` in desktop-env.ts,
    // the `any` at the untyped Obsidian/isomorphic-git boundary. Keeping them on
    // would mean two linters arguing about the same lines, so general TS rules
    // stay with Biome and only the Obsidian-aware rules survive here.
    ...tseslint.configs.disableTypeChecked,
    files: ['**/*.ts'],
  },
  {
    // After `disableTypeChecked`, which nulls the program: several *obsidianmd*
    // rules are themselves type-aware, so hand the parser a project again.
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-undef': 'off', // tsc owns this, and it doesn't know Electron's `require`

      // Flags "Obsidian Guardian" and the "OG:" status-bar prefix as
      // title-cased UI text. The product name is a proper noun and the prefix is
      // an initialism, so every hit is a false positive.
      'obsidianmd/ui/sentence-case': 'off',

      // Wants `window.setTimeout` over the bare global for popout-window
      // compatibility. The only timers here are the debouncers in watcher.ts,
      // which belong to the plugin instance rather than to any window, and are
      // unit-tested in a Node environment where `window` doesn't exist.
      'obsidianmd/prefer-window-timers': 'off',

      // Obsidian 1.13's declarative settings API (getSettingDefinitions), which
      // would put our settings in the settings search. Worth adopting, but it's
      // a feature, not a lint fix — tracked in plans/future-plugin-work.md.
      'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
    },
  },
  {
    // The one file allowed to touch Node builtins, and only through the runtime
    // `require()` this rule asks for — never a top-level import, which would
    // evaluate at load on mobile. Its header documents the contract; the rule
    // can't see that the calls sit behind `resolveEnv`'s desktop branch.
    files: ['src/desktop-env.ts'],
    rules: { 'obsidianmd/no-nodejs-modules': 'off' },
  },
  {
    files: ['src/main.ts'],
    rules: {
      // `import … from 'buffer'` here is not the Node builtin: tsdown aliases
      // the specifier to the bundled feross polyfill (see tsdown.config.ts), so
      // it resolves to plain JS on mobile too.
      'obsidianmd/no-nodejs-modules': 'off',
      // isomorphic-git reads a *global* `Buffer`, so the polyfill has to land on
      // globalThis; a per-window `window.Buffer` would not be seen by it.
      'obsidianmd/no-global-this': 'off',
    },
  },
  {
    // Build config and tests run in Node, never in the app — and a test may
    // legitimately name `.obsidian` as the fixture value for a config folder.
    files: ['tsdown.config.ts', 'test/**/*.ts'],
    rules: {
      'obsidianmd/no-nodejs-modules': 'off',
      'obsidianmd/hardcoded-config-path': 'off',
    },
  },
]
