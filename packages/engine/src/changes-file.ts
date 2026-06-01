import type { ChangeEntry, SnapshotStatus } from './types'

const KIND_LABEL: Record<ChangeEntry['kind'], string> = {
  add: 'added',
  modify: 'modified',
  delete: 'deleted',
  rename: 'renamed',
}

/** Render one change as a plain (non-checkbox) Markdown list item. */
function renderEntry(entry: ChangeEntry): string {
  const label = KIND_LABEL[entry.kind]
  const stats = entry.binary ? 'binary' : `+${entry.added} -${entry.removed}`
  const from =
    entry.kind === 'rename' && entry.renamedFrom
      ? ` (from \`${entry.renamedFrom}\`)`
      : ''
  return `- **${label}** ${toLink(entry.path)} \`${stats}\`${from}`
}

/** Markdown link to a vault path: wikilink for notes, code span otherwise. */
function toLink(path: string): string {
  if (path.toLowerCase().endsWith('.md')) {
    return `[[${path.slice(0, -3)}]]`
  }
  return `\`${path}\``
}

/**
 * Render a rotating, immutable signal file for a {@link SnapshotStatus}. The
 * bless control is the frontmatter boolean `accepted` (Obsidian shows it as a
 * checkbox in Properties); toggling it `true` and letting it sync back is the
 * bless signal. The file is keyed to an immutable snapshot oid + seq, so the
 * adapter never rewrites it — it writes a new file per snapshot instead.
 */
export function renderChangesFile(
  status: SnapshotStatus,
  vaultName: string,
): string {
  const fm: string[] = ['---', `vault: ${vaultName}`]
  if (!status.clean) fm.push('accepted: false')
  fm.push(
    `snapshot: ${status.snapshot}`,
    `seq: ${status.seq}`,
    `baseline: ${status.baseline ? status.baseline.slice(0, 7) : 'none'}`,
    `baseline_at: ${status.baselineAt ?? 'none'}`,
    `updated_at: ${status.generatedAt}`,
    '---',
  )
  const frontmatter = fm.join('\n')

  if (status.clean) {
    return `${frontmatter}\n\n# Changes\n\nNothing pending since the last blessed baseline.\n`
  }

  const count = status.changes.length
  const lines = status.changes.map(renderEntry).join('\n')
  return `${frontmatter}\n\n# Changes\n\n${count} change${count === 1 ? '' : 's'} from baseline:\n\n${lines}\n\nToggle **accepted** in the properties above to bless this snapshot as the new baseline.\n`
}
