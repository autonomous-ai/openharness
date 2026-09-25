/**
 * `harness tui` — Harness in a terminal. The TUI itself is a native binary (`tui/` at the repo root,
 * Rust); this is only how the CLI finds it and hands it the terminal. It is a client of the same
 * daemon the desktop app talks to, so there is nothing to configure: the machines, the relay and
 * the desk are the daemon's.
 *
 * Where the binary comes from, first hit wins:
 *   1. `HARNESS_TUI_BIN`
 *   2. `~/.harness/bin/harness-tui` — what `harness tui --install` downloads (checksum-verified)
 *   3. a dev checkout: `tui/target/{release,debug}/harness-tui` beside this CLI's source
 *   4. `harness-tui` on PATH
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TUI_MANIFEST_URL = process.env.HARNESS_TUI_MANIFEST_URL
  || 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/tui/metadata.json'

const installed = (): string => join(homedir(), '.harness', 'bin', 'harness-tui')

/** `darwin-arm64`, `linux-x64`, … — the key a release publishes each build under. */
export function platformKey(platform = process.platform, arch = process.arch): string | null {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null
  return os && cpu ? `${os}-${cpu}` : null
}

export function findTuiBinary(): string | null {
  const fromEnv = process.env.HARNESS_TUI_BIN
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  if (existsSync(installed())) return installed()
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    for (const up of ['../../../tui', '../../tui', '../tui']) {
      for (const profile of ['release', 'debug']) {
        const candidate = resolve(here, up, 'target', profile, 'harness-tui')
        if (existsSync(candidate)) return candidate
      }
    }
  } catch { /* bundled without a file URL */ }
  const which = spawnSync('sh', ['-c', 'command -v harness-tui'], { encoding: 'utf8' })
  const onPath = which.stdout?.trim()
  return which.status === 0 && onPath ? onPath : null
}

/** Download the published build for this platform, verify its sha256, install it. */
export async function installTui(log: (line: string) => void): Promise<string> {
  const key = platformKey()
  if (!key) throw new Error(`No harness tui build for ${process.platform}/${process.arch}.`)
  const manifest = await fetch(TUI_MANIFEST_URL, { signal: AbortSignal.timeout(20_000) })
  if (!manifest.ok) throw new Error(`The TUI is not published yet (${manifest.status}). Build it: cd tui && cargo build --release`)
  const meta = await manifest.json() as { version?: string; builds?: Record<string, { url?: string; sha256?: string }> }
  const build = meta.builds?.[key]
  if (!build?.url || !build.sha256) throw new Error(`No harness tui build for ${key} in the manifest.`)
  log(`  Downloading harness-tui ${meta.version ?? ''} for ${key}…`)
  const response = await fetch(build.url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`Download failed: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== build.sha256.toLowerCase()) throw new Error('The download does not match its published checksum; nothing was installed.')
  const target = installed()
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, bytes, { mode: 0o755 })
  chmodSync(temp, 0o755)
  renameSync(temp, target)
  log(`  ✓ Installed ${target}`)
  return target
}

async function daemonUp(port: number): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2_000) })).ok } catch { return false }
}

/** This CLI, run again: `harness login`, `harness start`. Their output is the person's to read. */
function runSelf(args: string[]): number {
  const script = process.argv[1]
  const result = spawnSync(process.execPath, [...process.execArgv, ...(script ? [script] : []), ...args], { stdio: 'inherit' })
  return result.status ?? 1
}

/**
 * One command on a fresh server: sign in if this computer never has (over SSH the login prints a URL
 * and takes the pasted callback), start the daemon if it is down, then open.
 */
async function ensureDaemon(port: number, signedIn: () => boolean): Promise<boolean> {
  if (!signedIn()) {
    console.log('\n  This computer is not signed in to Harness yet.')
    if (runSelf(['login']) !== 0 || !signedIn()) return false
  }
  if (await daemonUp(port)) return true
  console.log('  Starting the Harness daemon…')
  runSelf(['start'])
  for (let i = 0; i < 60; i++) {
    if (await daemonUp(port)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  console.error('  ✗ The Harness daemon did not come up. See `harness status`.')
  return false
}

export async function tuiCommand(argv: string[], opts: { port: number; signedIn?: () => boolean }): Promise<number> {
  if (argv[0] === '--install' || argv[0] === 'install') {
    try { await installTui((line) => console.log(line)); return 0 } catch (error) { console.error(`  ✗ ${(error as Error).message}`); return 1 }
  }
  if (argv[0] === '--where') { console.log(findTuiBinary() ?? '(not installed)'); return 0 }
  const informational = argv.some((arg) => ['-h', '--help', '-V', '--version'].includes(arg))
  if (!informational && opts.signedIn && !(await ensureDaemon(opts.port, opts.signedIn))) return 1
  let binary = findTuiBinary()
  if (!binary) {
    try { binary = await installTui((line) => console.log(line)) } catch (error) {
      console.error(`  ✗ ${(error as Error).message}`)
      return 1
    }
  }
  const result = spawnSync(binary, argv, {
    stdio: 'inherit',
    // How the TUI runs this CLI back (`harness link connect` for a machine it has to link).
    env: { ...process.env, PORT: String(opts.port), HARNESS_CLI: process.execPath, HARNESS_CLI_ARGS: JSON.stringify([...process.execArgv, process.argv[1] ?? '']) },
  })
  if (result.error) { console.error(`  ✗ Could not start ${binary}: ${result.error.message}`); return 1 }
  return result.status ?? 0
}
