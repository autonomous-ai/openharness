import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { buildLogBundle, bundleFileName } from './logBundle.js'
import type { BundleFacts } from './logBundleFacts.js'
import { redactSecretsInText } from './redactSecrets.js'

export interface LogsExportDeps {
  /** What followed `harness logs`: `export`, `--to <dir>`, `--days <n>`, `--json`. */
  args: readonly string[]
  logsDir: string
  dataDir: string
  version: string
  home: string
  cwd: string
  now: Date
  /** The README's `machine:` line; undefined when signed out. */
  machineId: string | undefined
  facts: () => Promise<BundleFacts>
  out: (line: string) => void
}

/**
 * `harness logs export [--to <dir>] [--days N] [--json]` — the last week of every log this product writes, with what
 * the status commands print and the apps' versions, zipped to the Desktop (or `--to`), secrets, emails and the home
 * folder blanked. The file a bug report is made of; the desktop app's Settings ▸ Debug ▸ Export logs and the menu-bar
 * app's Export logs run this same command.
 * Writes the zip and says where; resolves once it is written. Its real things are handed in, so a spec runs it without
 * this Mac's.
 */
export async function logsExportCommand(deps: LogsExportDeps): Promise<void> {
  const flagValue = (name: string): string | undefined => {
    const at = deps.args.indexOf(name)
    return at >= 0 ? deps.args[at + 1] : undefined
  }
  const days = Math.max(1, Number(flagValue('--days') ?? 7) || 7)
  const desktop = join(deps.home, 'Desktop')
  // Resolved, so a relative --to still answers an absolute path: the apps reveal the file by it.
  const to = resolve(deps.cwd, flagValue('--to') ?? (existsSync(desktop) ? desktop : deps.cwd))
  const facts = await deps.facts()
  const { zip, included } = buildLogBundle({
    logsDir: deps.logsDir, dataDir: deps.dataDir, days, now: deps.now, version: deps.version,
    notes: [`machine: ${deps.machineId ?? 'not signed in'}`, ...facts.versions],
    redact: redactSecretsInText, home: deps.home, status: facts.status, deviceAppLogsDir: facts.deviceAppLogsDir,
  })
  mkdirSync(to, { recursive: true })
  const path = join(to, bundleFileName(deps.now))
  writeFileSync(path, zip)
  if (deps.args.includes('--json')) deps.out(JSON.stringify({ path, included, bytes: zip.length }))
  else {
    // From the home it was handed, as the bundle's blanking is: `tildify` reads this computer's.
    const shown = path.startsWith(deps.home + sep) ? join('~', relative(deps.home, path)) : path
    deps.out(`wrote ${shown} (${Math.round(zip.length / 1024)} KB)`)
    for (const name of included) deps.out(`  ${name}`)
    if (!included.length) deps.out('  (no logs found)')
  }
}
