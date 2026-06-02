import type {
  ChangeEntry,
  ChangeKind,
  Status,
  Timeline,
} from '@obsidian-guardian/engine'

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

// ---------------------------------------------------------------------------
// Panel view-model — the DOM-free seam the review panel renders from. Built
// purely from an engine {@link Timeline}, so it is unit-testable without a DOM.
// ---------------------------------------------------------------------------

/** A view-ready file change row for the panel. */
export interface FileRow {
  kind: ChangeKind
  /** Full vault-relative path (forward slashes). */
  path: string
  /** Directory prefix ending in `/`, or '' at the vault root. */
  dir: string
  /** Final path segment (the file name). */
  name: string
  /** True when `path` is a markdown note (render as a clickable link). */
  markdown: boolean
  /** Pre-formatted stat string (`+3 -1` or `binary`). */
  stats: string
  /** For renames, the previous path. */
  from?: string
}

/** A checkpoint plus its diff to the working tree, view-ready. */
export interface CheckpointRow {
  /** Full checkpoint commit oid (the restore target). */
  oid: string
  /** Short oid for display. */
  shortHash: string
  seq: number
  /** ISO-8601 commit time (the view formats it). */
  when: string
  /** Net changes from this checkpoint → the working tree. */
  changes: FileRow[]
}

/** The complete data the review panel renders. */
export interface PanelData {
  /** Whether this device has activated reviewing (gitDir baseline exists). */
  active: boolean
  /** Baseline marker, or null when not yet onboarded. */
  baseline: { shortHash: string; when: string | null } | null
  /** Pending changes: baseline → working tree. */
  current: FileRow[]
  /** Device-local checkpoints, newest seq first. */
  checkpoints: CheckpointRow[]
  /** Peer presence summary for the header, or null when unknown. */
  peers: { count: number; updatedAt: string | null } | null
}

/** Split a path into a `dir` prefix (ending in `/`, or '') and a `name`. */
function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/')
  if (slash === -1) return { dir: '', name: path }
  return { dir: `${path.slice(0, slash)}/`, name: path.slice(slash + 1) }
}

/** Map one {@link ChangeEntry} to a {@link FileRow}. */
export function toFileRow(change: ChangeEntry): FileRow {
  const { dir, name } = splitPath(change.path)
  return {
    kind: change.kind,
    path: change.path,
    dir,
    name,
    markdown: isMarkdown(change.path),
    stats: formatStats(change),
    from: change.renamedFrom,
  }
}

/**
 * Build the full panel view-model from an engine {@link Timeline} (or null when
 * the device is inactive / not yet loaded). Pure — no DOM, no Obsidian.
 */
export function buildPanelData(args: {
  active: boolean
  timeline: Timeline | null
  peers?: { count: number; updatedAt: string | null } | null
}): PanelData {
  const { active, timeline, peers = null } = args
  if (!timeline) {
    return { active, baseline: null, current: [], checkpoints: [], peers }
  }
  return {
    active,
    baseline: {
      shortHash: shortMarker(timeline.baseline.oid),
      when: timeline.baseline.when,
    },
    current: timeline.current.map(toFileRow),
    checkpoints: timeline.checkpoints.map((cp) => ({
      oid: cp.oid,
      shortHash: cp.oid.slice(0, 7),
      seq: cp.seq,
      when: cp.when,
      changes: cp.changes.map(toFileRow),
    })),
    peers,
  }
}
