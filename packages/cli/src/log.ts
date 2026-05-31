/** A single ISO-8601 timestamp prefix for log lines. */
function ts(): string {
  return new Date().toISOString()
}

/** Write an informational line to stdout, timestamped. */
export function info(message: string): void {
  process.stdout.write(`${ts()} ${message}\n`)
}

/** Write an error line to stderr, timestamped. */
export function error(message: string): void {
  process.stderr.write(`${ts()} ${message}\n`)
}
