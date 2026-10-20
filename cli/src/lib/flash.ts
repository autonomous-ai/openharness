/**
 * `harness flash` — re-flash a plugged-in CIRCLE device over USB.
 *
 * This is a WRAPPER, deliberately. The flasher itself is a 415-line shell script published at
 * `<WEB_URL>/flash-circle.sh`, and it stays the single source of truth for everything that decides
 * whether a board survives the write: the chip it will talk to, the app offset, the otadata and NVS
 * regions, the flash mode/size/frequency, and the sha256 checks on both esptool and the firmware.
 * Re-implementing that here would put those numbers in two places, and the failure mode of a
 * disagreement is a bricked board that needs a USB cable and a person to recover.
 *
 * This file chooses the script, gets it, and passes the user's flags through untouched. On Windows
 * it also supplies a private completion callback so the CLI can forget the flashed board's old verdict
 * before the script starts the daemon again. All decisions about writing the board stay in the script.
 *
 * Flags are passed through verbatim rather than parsed. `--detect-only`, `--port`, `--yes`,
 * `--version`, `--erase-nvs`, `--no-verify` and `--no-flash` therefore work without this file knowing
 * they exist — and a flag added to the script later works the day it ships, instead of the day someone
 * remembers to widen a list here.
 *
 * On Windows the flasher is `flash-circle.ps1`, the PowerShell twin of the shell script (same steps, flags, numbers
 * and output; a website test holds the numbers equal), run with Windows PowerShell 5.1, which every Windows 10/11
 * has. Which script and how to run it is `flasherScript`.
 */

import { spawn } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { env } from '../config/env.js'
import { completeFlash } from './flashRecovery.js'

/**
 * The script caches its own downloads (esptool, firmware) under `~/.harness/flasher` via
 * `HARNESS_FLASHER_CACHE`. Keeping our copy of the script in the same directory is deliberate: one
 * place holds everything the flasher owns, so "delete this folder" is a complete reset.
 */
const CACHE_DIR = process.env.HARNESS_FLASHER_CACHE || join(homedir(), '.harness', 'flasher')
const FETCH_TIMEOUT_MS = 20_000

export interface FlasherScript {
  /** Its name at `<WEB_URL>/` and in the cache folder. */
  name: string
  /** Whether a downloaded body is the script and not a captive portal's page. */
  looksRight(body: string): boolean
  /** What it is, for the message when it is not. */
  kind: string
  command(scriptPath: string, args: string[]): { file: string; args: string[] }
  /** How a person runs it by hand, line by line. */
  byHand(url: string): string[]
  /** What to say when its interpreter is missing. */
  missing: string
}

export function flasherScript(platform: NodeJS.Platform = process.platform): FlasherScript {
  if (platform === 'win32') {
    return {
      name: 'flash-circle.ps1',
      looksRight: (body) => body.split(/\r?\n/, 1)[0] === '# flash-circle.ps1',
      kind: 'the PowerShell flasher',
      // -ExecutionPolicy Bypass for this one process: a user's policy may refuse scripts. The file came from fetch,
      // which marks nothing as downloaded, so no SmartScreen or zone check is involved.
      command: (scriptPath, args) => ({ file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args] }),
      byHand: (url) => [`  irm ${url} -OutFile flash-circle.ps1`, '  powershell -NoProfile -ExecutionPolicy Bypass -File flash-circle.ps1'],
      missing: 'Windows PowerShell (powershell.exe) was not found, and the flasher is a PowerShell script.\nRun it yourself from a PowerShell window:',
    }
  }
  return {
    name: 'flash-circle.sh',
    looksRight: (body) => body.startsWith('#!'),
    kind: 'a shell script',
    command: (scriptPath, args) => ({ file: 'bash', args: [scriptPath, ...args] }),
    byHand: (url) => [`  curl -fsSL ${url} -o flash-circle.sh`, '  bash flash-circle.sh'],
    missing: 'bash was not found on PATH, and the flasher is a bash script.\nInstall bash, or run it yourself on a machine that has one:',
  }
}

export interface FlashDeps {
  /** Overridden in tests; the real one is `fetch`. */
  fetchScript: (url: string) => Promise<string>
  readCache: () => string | null
  writeCache: (body: string) => void
  run: (scriptPath: string, args: string[], environment?: NodeJS.ProcessEnv) => Promise<number>
  log: (line: string) => void
  warn: (line: string) => void
  /** Which flasher: overridden in tests; the real one is this machine's. */
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  complete?: (port: string) => Promise<void>
}

export function scriptUrl(platform: NodeJS.Platform = process.platform): string {
  return `${env.WEB_URL.replace(/\/+$/, '')}/${flasherScript(platform).name}`
}

async function realFetch(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    // The server already answers `no-store` for a reason it states out loud: an operator must never be
    // handed a stale flasher after a fix has shipped. Say the same thing from this side so a proxy in
    // between cannot decide otherwise.
    headers: { 'cache-control': 'no-cache' },
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.text()
}

function realRun(script: FlasherScript) {
  return (scriptPath: string, args: string[], environment?: NodeJS.ProcessEnv): Promise<number> => new Promise((resolve, reject) => {
    const { file, args: argv } = script.command(scriptPath, args)
    // `inherit`, not a pipe. The script prints progress as it goes and asks for confirmation on the
    // terminal; capturing its output would hide the first and break the second.
    const child = spawn(file, argv, { stdio: 'inherit', windowsHide: true, env: environment })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

function defaultsFor(platform: NodeJS.Platform): { deps: FlashDeps; cached: string } {
  const script = flasherScript(platform)
  const cached = join(CACHE_DIR, script.name)
  return {
    cached,
    deps: {
      fetchScript: realFetch,
      readCache: () => {
        try { return readFileSync(cached, 'utf-8') } catch { return null }
      },
      writeCache: (body) => {
        mkdirSync(dirname(cached), { recursive: true })
        writeFileSync(cached, body, { mode: 0o755 })
      },
      run: realRun(script),
      log: (line) => console.log(line),
      warn: (line) => console.error(line),
      platform,
    },
  }
}

/**
 * Fetch-then-fall-back, and always say which one happened.
 *
 * The network copy wins whenever it can be had, because a flasher fix has to reach the person holding
 * the board. The cache exists only so a flash is still possible on a machine that is offline — which
 * is a real situation at a bench — and using it is reported, never silent.
 *
 * A captive portal or an error page returns 200 with HTML. Running that does nothing useful and reports it
 * confusingly, so the body is checked before it is ever written to disk, and a wrong one falls back as a
 * failed download does.
 */
async function resolveScript(deps: FlashDeps, script: FlasherScript, cached: string): Promise<{ body: string; source: 'fetched' | 'cached' }> {
  const url = scriptUrl(deps.platform)
  try {
    const body = await deps.fetchScript(url)
    if (!script.looksRight(body)) throw new Error(`response is not ${script.kind} (proxy or error page?)`)
    deps.writeCache(body)
    return { body, source: 'fetched' }
  } catch (err) {
    const fromCache = deps.readCache()
    const why = err instanceof Error ? err.message : String(err)
    if (fromCache === null) {
      throw new Error(
        `could not download the flasher from ${url} (${why}), and no cached copy exists.\n`
        + 'With a working connection you can always run it by hand:\n'
        + script.byHand(url).join('\n'),
      )
    }
    deps.warn(`!  could not reach ${url} (${why})`)
    deps.warn(`!  running the CACHED flasher from ${cached} — it may be out of date`)
    return { body: fromCache, source: 'cached' }
  }
}

/**
 * Run the published circle flasher with `args` passed straight through.
 *
 * Returns the script's own exit code so `harness flash --detect-only` is usable in a shell condition:
 * the script exits non-zero when it finds no board, and that has to survive the wrapper.
 */
export async function flashCommand(args: string[], overrides: Partial<FlashDeps> = {}): Promise<number> {
  const platform = overrides.platform ?? process.platform
  const environment = overrides.environment ?? process.env
  // Only the Windows flasher child gets this capability. Its successful write must invalidate the
  // selected board's old verdict before `finally` starts the daemon, which was absent during the flash.
  if (args[0] === '__complete') {
    if (platform !== 'win32' || args.length !== 2 || !environment.HARNESS_FLASH_RECOVERY_NODE || !environment.HARNESS_FLASH_RECOVERY_ARGS) {
      throw new Error('invalid flash completion callback')
    }
    await (overrides.complete ?? completeFlash)(args[1])
    return 0
  }
  const { deps: defaults, cached } = defaultsFor(platform)
  const deps: FlashDeps = { ...defaults, ...overrides, platform }
  const script = flasherScript(platform)
  const { source } = await resolveScript(deps, script, cached)
  deps.log(`>> circle flasher (${source === 'fetched' ? scriptUrl(platform) : `cached: ${cached}`})`)
  try {
    // `--yes` FIRST, ALWAYS. The prompt in the script exists for the standalone `curl | bash` case, where
    // the operator may not know what is plugged in; it still guards that path. Reaching a board through
    // `harness flash` is a different situation — the person typed the product's own command at the
    // product's own device — and the check that actually prevents damage is the script's refusal to write
    // to anything that is not an ESP32-S3. A confirmation in front of a customer converting the device
    // they own is friction wearing the clothes of safety. The user's own flags follow and still win.
    const childEnvironment = platform === 'win32' ? {
      ...environment,
      HARNESS_FLASH_RECOVERY_NODE: process.execPath,
      HARNESS_FLASH_RECOVERY_ARGS: JSON.stringify([...process.execArgv, process.argv[1]]),
    } : environment
    return await deps.run(cached, ['--yes', ...args], childEnvironment)
  } catch (err) {
    // The only way `spawn` itself fails here in practice: the script's interpreter is missing. Say what to do
    // instead of just failing.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`${script.missing}\n${script.byHand(scriptUrl(platform)).join('\n')}`)
    }
    throw err
  }
}
