#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { createEngine, formatStatus } from './commands'
import { type ConfigInput, resolveConfig } from './config'
import { error, info } from './log'
import { runWatch } from './watch'

const USAGE = `obsidian-guardian — review what agents changed in an Obsidian vault

Usage:
  obsidian-guardian <command> [options]

Commands:
  onboard            Initialise the repo and set the baseline to the current state
  status             Print pending changes since the baseline
  refresh            Recompute status and (re)write the review note
  bless              Advance the baseline to the current state
  revert <path>      Restore one vault-relative path from the baseline
  rollback           Restore the whole vault to the baseline
  tag <name>         Write a named snapshot (tag) at the current baseline
  watch              Refresh the review note on every change (long-running)

Options:
  --vault <path>          Vault folder (default: $OG_VAULT or cwd)
  --git-dir <path>        Git database, outside the vault (default: <vault>.gitdir)
  --review-folder <name>  Review-artifact folder (default: _OG)
  --replica-id <id>       Override the per-replica review filename seed
  --json                  Machine-readable JSON output (status)
  --poll                  Use polling for fs events (watch; bind-mount safe)
  --debounce <ms>         Debounce window for watch refreshes (default: 300)
  -h, --help              Show this help
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    vault: { type: 'string' },
    'git-dir': { type: 'string' },
    'review-folder': { type: 'string' },
    'replica-id': { type: 'string' },
    json: { type: 'boolean', default: false },
    poll: { type: 'boolean', default: false },
    debounce: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const [command, arg] = positionals

function configInput(): ConfigInput {
  return {
    vault: values.vault,
    gitDir: values['git-dir'],
    reviewFolder: values['review-folder'],
    replicaId: values['replica-id'],
  }
}

async function main(): Promise<void> {
  if (values.help || !command) {
    process.stdout.write(USAGE)
    return
  }

  const config = resolveConfig(configInput())
  const engine = await createEngine(config)

  switch (command) {
    case 'onboard': {
      info(`onboarded vault ${config.vaultPath} (git-dir ${config.gitDir})`)
      return
    }
    case 'status': {
      const status = await engine.status()
      if (values.json)
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
      else process.stdout.write(`${formatStatus(status)}\n`)
      return
    }
    case 'refresh': {
      const status = await engine.refresh()
      info(formatStatus(status))
      return
    }
    case 'bless': {
      await engine.bless()
      info('blessed — baseline advanced to the current state')
      return
    }
    case 'revert': {
      if (!arg) throw new Error('revert requires a <path> argument')
      await engine.revert(arg)
      info(`reverted ${arg} to the baseline`)
      return
    }
    case 'rollback': {
      await engine.rollback()
      info('rolled back — vault restored to the baseline')
      return
    }
    case 'tag': {
      if (!arg) throw new Error('tag requires a <name> argument')
      await engine.tag(arg)
      info(`tagged baseline as ${arg}`)
      return
    }
    case 'watch': {
      const debounceMs = values.debounce ? Number(values.debounce) : undefined
      info(
        `watching ${config.vaultPath} — review note at ${config.reviewFolder}/${engine.reviewNoteName}`,
      )
      const handle = await runWatch(engine, config, {
        poll: values.poll,
        debounceMs,
        onRefresh: (status) => info(formatStatus(status)),
      })
      const stop = async (): Promise<void> => {
        await handle.close()
        process.exit(0)
      }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
      return
    }
    default:
      throw new Error(`unknown command: ${command}\n\n${USAGE}`)
  }
}

main().catch((err: unknown) => {
  error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
