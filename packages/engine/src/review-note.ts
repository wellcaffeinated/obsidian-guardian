import type { ChangeEntry, Status } from './types'

const KIND_LABEL: Record<ChangeEntry['kind'], string> = {
  add: 'added',
  modify: 'modified',
  delete: 'deleted',
  rename: 'renamed',
}

/** Render a single change as a Markdown checklist item. */
function renderEntry(entry: ChangeEntry): string {
  const label = KIND_LABEL[entry.kind]
  const stats = entry.binary ? 'binary' : `+${entry.added} -${entry.removed}`
  const link = toLink(entry.path)
  const from =
    entry.kind === 'rename' && entry.renamedFrom
      ? ` (from \`${entry.renamedFrom}\`)`
      : ''
  return `- [ ] **${label}** ${link} \`${stats}\`${from}`
}

/** Markdown link to a vault path: wikilink for notes, code span otherwise. */
function toLink(path: string): string {
  if (path.toLowerCase().endsWith('.md')) {
    return `[[${path.slice(0, -3)}]]`
  }
  return `\`${path}\``
}

/**
 * Render the review note Markdown for a {@link Status}. Self-contained: the
 * adapter just writes the returned string into the review folder.
 */
export function renderReviewNote(status: Status, vaultName: string): string {
  const noteStatus = status.clean ? 'blessed' : 'active'
  const frontmatter = [
    '---',
    `vault: ${vaultName}`,
    `baseline: ${status.marker ?? 'none'}`,
    `status: ${noteStatus}`,
    `generated: ${status.generatedAt}`,
    '---',
  ].join('\n')

  if (status.clean) {
    return `${frontmatter}\n\n# Pending review — ${vaultName}\n\n> [!success] Clean\n> Nothing pending since the last blessed baseline.\n`
  }

  const count = status.changes.length
  const lines = status.changes.map(renderEntry).join('\n')
  return `${frontmatter}\n\n# Pending review — ${vaultName}\n\n${count} change${count === 1 ? '' : 's'} since the last blessed baseline:\n\n${lines}\n`
}
