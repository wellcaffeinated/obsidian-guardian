import type { Author } from './types'

/** Default folder (vault-relative) for review artifacts. */
export const DEFAULT_REVIEW_FOLDER = '_Review'

/** Default branch name used as the advanceable baseline marker. */
export const DEFAULT_MARKER = 'baseline'

/** Default identity recorded on bless/baseline commits. */
export const DEFAULT_AUTHOR: Author = {
  name: 'Obsidian Bedrock',
  email: 'bedrock@localhost',
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
