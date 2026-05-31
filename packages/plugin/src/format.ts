import type { ChangeEntry, ChangeKind, Status } from '@obsidian-guardian/engine'

/** Compact per-file stat string: `+3 -1`, or `binary` when not line-diffable. */
export function formatStats(change: ChangeEntry): string {
  return change.binary ? 'binary' : `+${change.added} -${change.removed}`
}

/** True for paths Obsidian can open as a note (clickable in the panel). */
function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith('.md')
}

/** A view-ready description of one change, free of any DOM/Obsidian dependency. */
export interface ChangeRow {
  kind: ChangeKind
  path: string
  /** True when `path` is a markdown note (render as a clickable link). */
  markdown: boolean
  /** Pre-formatted stat string. */
  stats: string
  /** For renames, the previous path. */
  from?: string
}

/** Map one {@link ChangeEntry} to its view row. */
function describeChange(change: ChangeEntry): ChangeRow {
  return {
    kind: change.kind,
    path: change.path,
    markdown: isMarkdown(change.path),
    stats: formatStats(change),
    from: change.renamedFrom,
  }
}

/** Map a whole {@link Status} to view rows (one per change, order preserved). */
export function describeStatus(status: Status): ChangeRow[] {
  return status.changes.map(describeChange)
}

/** Short form of a commit marker for display. */
export function shortMarker(marker: string | null): string {
  return marker ? marker.slice(0, 7) : 'none'
}
