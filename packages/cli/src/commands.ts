import { ReviewEngine, type Status } from '@obsidian-guardian/engine'
import type { ResolvedConfig } from './config'

/** Short form of a commit marker for human output. */
function short(marker: string | null): string {
  return marker ? marker.slice(0, 7) : 'none'
}

/**
 * Construct a {@link ReviewEngine} for a resolved config and ensure the repo is
 * onboarded (idempotent — never advances the baseline on an existing repo).
 */
export async function createEngine(
  config: ResolvedConfig,
): Promise<ReviewEngine> {
  const engine = new ReviewEngine(config)
  await engine.onboard()
  return engine
}

/** Render a {@link Status} as a compact, human-readable block for the terminal. */
export function formatStatus(status: Status): string {
  if (status.clean) {
    return `clean — nothing pending since baseline ${short(status.marker)}`
  }
  const lines = status.changes.map((c) => {
    const stats = c.binary ? 'binary' : `+${c.added} -${c.removed}`
    const from = c.renamedFrom ? ` (from ${c.renamedFrom})` : ''
    return `  ${c.kind.padEnd(8)} ${c.path}  ${stats}${from}`
  })
  const n = status.changes.length
  return [
    `${n} change${n === 1 ? '' : 's'} since baseline ${short(status.marker)}:`,
    ...lines,
  ].join('\n')
}
