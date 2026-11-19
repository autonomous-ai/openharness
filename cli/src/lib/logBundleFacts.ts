import { execFile } from 'node:child_process'
import { isAbsolute, join } from 'node:path'

/**
 * What `harness logs export` learns by running programs, for the bundle (logBundle.ts) to write: `status.txt` (five
 * status commands of this same CLI), the versions in the README (Node, the OS, the Mac apps the dial follows), and where
 * the Harness menu-bar app keeps its log. Runs in the `harness` command's own process, never in the core's. Every
 * program is run through an injected `Run`, so its specs start nothing of the computer they run on.
 */

export interface RunResult { code: number | null; stdout: string; timedOut: boolean }
/** One program run to its end with no shell: its stdout, never its stderr. Never rejects. */
export type Run = (file: string, args: readonly string[], timeoutMs: number) => Promise<RunResult>

export const STATUS_TIMEOUT_MS = 10_000
export const VERSION_TIMEOUT_MS = 2_000
/** A status or version answer is a few lines; past this the output is not ours to read. */
export const FACT_OUTPUT_MAX_BYTES = 256 * 1024

/** `status`, then `device claude|codex|vscode|cursor status --json`. */
export const STATUS_COMMANDS: readonly (readonly string[])[] = [
  ['status'],
  ['device', 'claude', 'status', '--json'],
  ['device', 'codex', 'status', '--json'],
  ['device', 'vscode', 'status', '--json'],
  ['device', 'cursor', 'status', '--json'],
]

/** Harness, Harness Device, Orca, Visual Studio Code, ChatGPT, Claude, Herdr. */
export const APPS: readonly string[] = ['Harness', 'Harness Device', 'Orca', 'Visual Studio Code', 'ChatGPT', 'Claude', 'Herdr']

/** Tauri's `app_log_dir` names the menu-bar app's folder by its bundle id. */
const DEVICE_APP_ID = 'ai.autonomous.harness.device'
/** What a version written into the README may hold: anything else an app's Info.plist says is not shown. */
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/

export interface FactsDeps {
  /** How this CLI was started: `process.execPath`, `process.execArgv`, then `process.argv[1]`. */
  self: readonly string[]
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
  /** `process.version`. */
  nodeVersion: string
  /** `os.release()`. */
  osRelease: string
  exists: (path: string) => boolean
  run: Run
}

export interface BundleFacts { status: string; versions: string[]; deviceAppLogsDir: string | undefined }

/** The real runner. Its time ends it with SIGKILL, as `claudeRunner` (devices/claudePlugin.ts): a status command that
 *  does not end on TERM would hold the export past the desktop app's wait. */
export const runCommand: Run = (file, args, timeoutMs) => new Promise((resolve) => {
  const child = execFile(file, [...args],
    { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: FACT_OUTPUT_MAX_BYTES, windowsHide: true },
    (error, stdout) => {
      // A kill, a missing file or output past the bound has no exit code: it is no answer. `killed` is set by the
      // timeout and by the output bound alike; only the first is a timeout.
      const code = !error ? 0 : typeof error.code === 'number' ? error.code : null
      const timedOut = !!error?.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      resolve({ code, stdout, timedOut })
    })
  // Nothing is asked on stdin: a command that waits for it would only run out its time.
  child.stdin?.end()
})

/** [run] started now, so callers start every run before awaiting any; null for a run that threw or rejected. */
function start(run: Run, file: string, args: readonly string[], timeoutMs: number): Promise<RunResult | null> {
  try {
    return run(file, args, timeoutMs).catch(() => null)
  } catch {
    return Promise.resolve(null)
  }
}

function statusAnswer(result: RunResult | null): string {
  if (result?.timedOut) return `(no answer: timed out after ${STATUS_TIMEOUT_MS / 1000} s)`
  if (result?.code === 0) return result.stdout.trimEnd() || '(no output)'
  if (typeof result?.code === 'number') return `(exit ${result.code})`
  return '(no answer)'
}

/** `status.txt`: each of STATUS_COMMANDS under `$ harness <its words>`. All five run at once: one after another, five
 *  timeouts would outlast the desktop app's 30 s wait for the export. */
export async function statusText(self: readonly string[], run: Run): Promise<string> {
  const [file, ...prefix] = self
  const results = await Promise.all(STATUS_COMMANDS.map((words) => start(run, file, [...prefix, ...words], STATUS_TIMEOUT_MS)))
  return STATUS_COMMANDS.map((words, i) => `$ harness ${words.join(' ')}\n${statusAnswer(results[i])}`).join('\n\n') + '\n'
}

/** The trimmed stdout of a run that exited 0 with something shaped like a version; undefined otherwise. */
async function versionFrom(answer: Promise<RunResult | null>): Promise<string | undefined> {
  const result = await answer
  const version = result?.code === 0 ? result.stdout.trim() : ''
  return VERSION.test(version) ? version : undefined
}

/** Node, the OS, and on a Mac each of APPS found in `/Applications` or `~/Applications` with a version it states. */
export async function versionLines(deps: FactsDeps): Promise<string[]> {
  const node = `node: ${deps.nodeVersion}`
  if (deps.platform !== 'darwin') return [node, `os: ${deps.platform} ${deps.osRelease}`]
  const macOS = versionFrom(start(deps.run, '/usr/bin/sw_vers', ['-productVersion'], VERSION_TIMEOUT_MS))
  const apps = APPS.map((app) => {
    const plist = ['/Applications', join(deps.home, 'Applications')]
      .map((root) => join(root, `${app}.app`, 'Contents', 'Info.plist'))
      .find((path) => deps.exists(path))
    return plist === undefined ? Promise.resolve(undefined) : versionFrom(start(deps.run, '/usr/bin/plutil',
      ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], VERSION_TIMEOUT_MS))
  })
  const os = await macOS
  const found = (await Promise.all(apps)).flatMap((version, i) => version === undefined ? [] : [`${APPS[i]}: ${version}`])
  return [node, os === undefined ? `os: darwin ${deps.osRelease}` : `os: macOS ${os}`, ...found]
}

/** Where Tauri's `app_log_dir` puts the menu-bar app's log; undefined where it cannot be named. */
export function deviceAppLogsDir(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string | undefined {
  if (platform === 'darwin') return join(home, 'Library', 'Logs', DEVICE_APP_ID)
  if (platform === 'linux') {
    // XDG's rule: a relative XDG_DATA_HOME is invalid and ignored.
    const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, '.local', 'share')
    return join(data, DEVICE_APP_ID, 'logs')
  }
  if (platform === 'win32') return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, DEVICE_APP_ID, 'logs') : undefined
  return undefined
}

/** The three, the status and the versions at the same time. Never rejects. */
export async function collectBundleFacts(deps: FactsDeps): Promise<BundleFacts> {
  const [status, versions] = await Promise.all([statusText(deps.self, deps.run), versionLines(deps)])
  return { status, versions, deviceAppLogsDir: deviceAppLogsDir(deps.platform, deps.home, deps.env) }
}
