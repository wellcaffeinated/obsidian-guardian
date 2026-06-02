import type { Author } from './types'

/** Default folder (vault-relative) for review artifacts. */
export const DEFAULT_REVIEW_FOLDER = '_OG'

/** Default branch name used as the advanceable baseline marker. */
export const DEFAULT_MARKER = 'baseline'

/**
 * How long a received bless stays applicable. Its only job is the rare ABA case
 * (content cycling back to long-ago-blessed bytes); dropping a legitimately
 * delayed bless (a device offline a while) is the worse failure, so the window
 * must exceed any realistic offline+sync-settle gap. 30 days clears that while
 * still expiring truly-dead one-off records for GC. Ordinary dedup is handled
 * independently by the per-client seq high-water mark.
 */
export const FRESHNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** Default identity recorded on bless/baseline commits. */
export const DEFAULT_AUTHOR: Author = {
  name: 'Obsidian Guardian',
  email: 'guardian@localhost',
}

/**
 * Ignore globs always applied (via `info/exclude`): volatile Obsidian state
 * and OS cruft. Notes and (by default) `.obsidian` plugins/settings stay
 * tracked. The review folder is ignored dynamically by the engine.
 */
export const DEFAULT_IGNORE: readonly string[] = [
  '.obsidian/workspace.json',
  '.obsidian/workspace-mobile.json',
  '.obsidian/workspace*.json',
  '.obsidian/cache',
  '.trash/',
  '.DS_Store',
]
