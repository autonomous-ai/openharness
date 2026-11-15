/**
 * Installing an engine on Windows, as a launch needs one: one hidden installer per engine, whoever asks, with the same
 * answers as `createNativeInstallations` (./nativeInstall.ts), whose evidence walks POSIX paths and runs POSIX shell
 * lines. Here each engine has one record, overwritten by its next install. A launch only ever believes the program it
 * can then find (kit/launchExecutable.ts), so a record says how the install went and never that the engine is there.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ENGINE_WINDOWS_INSTALL, npmEnginePrefix, type EngineInstallRecipe, type WindowsInstall } from '../../lib/engineInstall.js'
import { managedNodePath } from '../../lib/nodeRuntime.js'
import { powershellPath } from '../../lib/windows/powershell.js'
import type { AgentEngine } from '../types.js'
import type { NativeInstallation } from './nativeInstall.js'

/** As the Mac's helper: an installer past this is ended, and said to have taken too long. */
export const WINDOWS_INSTALL_LIMIT_MS = 20 * 60_000
/** A running record older than this has nobody behind it, even if another process took its pid. */
const RECORD_SETTLES_MS = WINDOWS_INSTALL_LIMIT_MS + 60_000

interface InstallPlaces { npm: string; prefix: string; comspec: string; powershell: string }
interface SpawnPlaces extends InstallPlaces { node: string; nodeDir: string }
export interface InstallCommand { file: string; args: string[]; verbatim: boolean }

const INSTALL_COMMAND_VARIABLE = 'HARNESS_INSTALL_COMMAND'
/**
 * What the daemon starts, which starts the installer and says how it ended. An installer needs two things Node gives only one of
 * at a time. To outlive the daemon it must be detached, since Node kills its other children with it (libuv's job object). But
 * detached takes the console away, and PowerShell without one exits 0 at once having run nothing: no PowerShell installer ever
 * ran (Hermes on DESKTOP-0TFH0OJ, 2026-11-04). So this small process is the detached one, and its child has a console no one sees.
 * Through `cmd` instead, the hidden console takes the output, and the person is told nothing of why an install failed.
 */
export const INSTALL_RUNNER = String.raw`
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), { stripVTControlCharacters } = require('node:util');
const { file, args, verbatim, record, request, dispatch, log } = JSON.parse(process.env.HARNESS_INSTALL_COMMAND);
delete process.env.HARNESS_INSTALL_COMMAND;
function publish(value) {
  if (!record) return;
  const owner = JSON.parse(fs.readFileSync(record, 'utf8'));
  if (owner.dispatch !== dispatch || owner.request !== request) throw Error('Installation dispatch ownership changed');
  const next = record + '.' + process.pid + '.next';
  const fd = fs.openSync(next, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(next, record);
}
function detail(fallback) {
  if (!log) return fallback;
  let fd;
  try {
    fd = fs.openSync(log, 'r'); const size = fs.fstatSync(fd).size, bytes = Buffer.alloc(Math.min(size, 65536));
    const read = fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    return stripVTControlCharacters(bytes.subarray(0, read).toString('utf8')).split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1)?.slice(0, 300) || fallback;
  } catch { return fallback; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
let timer, timedOut = false;
function finish(code, reason) {
  clearTimeout(timer);
  const why = timedOut ? 'it took longer than 20 minutes.' : reason || detail('its installer stopped with code ' + code + '.');
  try { publish(code === 0 && !timedOut ? { state: 'done', request } : { state: 'failed', request, detail: why }); }
  catch { console.error('Installation result needs recovery.'); process.exit(2); }
  process.exit(timedOut ? 1 : code ?? 1);
}
try {
  // The old controller must still read failed for this request, even if this helper later dies.
  publish({ state: 'failed', request, detail: 'Installation dispatch needs recovery.', dispatch, pid: process.pid, startedAt: Date.now() });
  const child = spawn(file, args, { windowsHide: true, windowsVerbatimArguments: verbatim, stdio: ['ignore', 1, 2] });
  child.once('error', error => { console.error(error.message); finish(1, error.message); });
  child.once('exit', code => finish(code ?? 1));
  timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32') execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => process.exit(2));
    else child.kill('SIGKILL');
  }, 20 * 60_000);
} catch (error) { console.error(error.message); finish(1, error.message); }
`

/**
 * The vendor's installer, as `irm <url> | iex` runs it, with its flags. As bytes when the server calls it a download, which
 * `irm` would not read as text (Antigravity's and Claude's are served as application/octet-stream).
 */
export function powershellInstallScript(url: string, args: readonly string[] = []): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    // A failure is said here and in words: past a failed download, an empty script would run and exit 0, an install that "finished".
    `try { $reply = Invoke-WebRequest -UseBasicParsing -ErrorAction Stop -Uri '${url.replace(/'/g, "''")}' } catch { [Console]::Error.WriteLine('its installer could not be downloaded: ' + $_.Exception.Message); exit 1 }`,
    '$text = if ($reply.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($reply.Content) } else { [string]$reply.Content }',
    `try { ${`& ([scriptblock]::Create($text.TrimStart([char]0xFEFF))) ${args.join(' ')}`.trimEnd()} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`,
    'if ($LASTEXITCODE) { exit $LASTEXITCODE }',
  ].join('\n')
}

export function windowsInstallCommand(install: WindowsInstall, places: InstallPlaces, arch: string = process.arch): InstallCommand {
  if ('powershell' in install) {
    // -Command and not -EncodedCommand: encoded, PowerShell writes its errors as CLIXML, and the person would be shown XML as the
    // reason. The script holds no double quote for Node to escape (a URL's quote is doubled, in single quotes).
    return { file: places.powershell, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', powershellInstallScript(install.powershell, install.args)], verbatim: false }
  }
  const words = [`"${places.npm}" install --global --prefix "${places.prefix}" --no-fund --no-audit --loglevel=error`,
    ...install.args ?? [], ...(arch === 'arm64' ? install.armArgs ?? [] : []), install.npm]
  // cmd's own quoting: /s takes everything between the outer quotes as it stands, spaces in a profile's name included.
  return { file: places.comspec, args: ['/d', '/s', '/c', `"${words.join(' ')}"`], verbatim: true }
}

type InstallRecord =
  | { state: 'running'; pid: number; request: string; startedAt: number }
  | { state: 'done' | 'failed'; request: string; detail?: string; dispatch?: string; pid?: number; startedAt?: number }

const running = (): NativeInstallation => ({ complete: false, running: true, detail: 'Installing.' })
const failed = (detail: string): NativeInstallation => ({ complete: false, failed: true, detail })
const recovery = (): NativeInstallation => ({ complete: false, detail: 'Engine installation needs recovery: its dispatch has no confirmed result.' })

function processRuns(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}


export function createWindowsInstallations({ directory, spawn = nodeSpawn, alive = processRuns, now = Date.now, where }: {
  directory: string
  spawn?: typeof nodeSpawn
  alive?: (pid: number) => boolean
  now?: () => number
  where?: () => SpawnPlaces
}) {
  const places = where ?? (() => {
    const node = managedNodePath()
    const nodeDir = dirname(node)
    return { node, nodeDir, npm: join(nodeDir, 'npm.cmd'), prefix: npmEnginePrefix(), comspec: process.env.ComSpec ?? 'cmd.exe', powershell: powershellPath() }
  })
  const recordFile = (engine: AgentEngine) => join(directory, `${engine}.json`)
  const read = (engine: AgentEngine): InstallRecord | null => {
    try {
      const record = JSON.parse(readFileSync(recordFile(engine), 'utf8')) as InstallRecord | null
      return record && typeof record.state === 'string' && typeof record.request === 'string' ? record : null
    } catch { return null }
  }
  const write = (engine: AgentEngine, record: InstallRecord) => {
    mkdirSync(directory, { recursive: true })
    const next = `${recordFile(engine)}.${process.pid}.next`
    const fd = openSync(next, 'w', 0o600)
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(next, recordFile(engine))
  }
  /** A running record with an installer behind it. One whose process is gone (a restart) or too old never holds a launch. */
  const live = (record: InstallRecord | null): boolean =>
    !!record && (record.state === 'running' || record.state === 'failed' && !!record.dispatch)
      && typeof record.pid === 'number' && record.pid > 0 && typeof record.startedAt === 'number'
      && alive(record.pid) && now() - record.startedAt < RECORD_SETTLES_MS

  const start = (engine: AgentEngine, environment: Record<string, string>, request: string): NativeInstallation => {
    const log = join(directory, `${engine}.log`)
    let dispatched = false
    try {
      mkdirSync(directory, { recursive: true })
      const at = places()
      const install = ENGINE_WINDOWS_INSTALL[engine as keyof typeof ENGINE_WINDOWS_INSTALL]
      if (!install) return failed('Harness has no way to install it on Windows.')
      const command = windowsInstallCommand(install, at)
      const env: NodeJS.ProcessEnv = { ...process.env, ...environment }
      // Windows' names ignore case: one PATH, Harness's Node first, so npm's scripts find it on a computer with none.
      const path = Object.keys(env).filter((key) => key.toLowerCase() === 'path').map((key) => { const value = env[key]; delete env[key]; return value }).find(Boolean)
      env.PATH = path ? `${at.nodeDir};${path}` : at.nodeDir
      rmSync(log, { force: true })
      const dispatch = randomUUID()
      // Failed is deliberately backward readable: rollback cannot replay this same saved request.
      write(engine, { state: 'failed', request, detail: 'Installation dispatch needs recovery.', dispatch })
      const output = openSync(log, 'w')
      let child
      try {
        // Detached, so a daemon restarting does not end it, and hidden. See INSTALL_RUNNER for why it does not run the installer itself.
        child = spawn(at.node, ['-e', INSTALL_RUNNER], { env: { ...env, [INSTALL_COMMAND_VARIABLE]: JSON.stringify({ ...command, record: recordFile(engine), request, dispatch, log }) }, cwd: directory, detached: true, windowsHide: true, stdio: ['ignore', output, output] })
        dispatched = true
      } finally { closeSync(output) }
      child.unref?.()
      const settle = (record: InstallRecord) => {
        const now = read(engine)
        if (now && 'dispatch' in now && now.dispatch === dispatch) write(engine, record)
      }
      child.once('exit', () => {
        // Only the helper's durable result proves completion. Killing it or losing that result cannot authorize retry.
        const record = read(engine)
        if (record && 'dispatch' in record && record.dispatch === dispatch) console.warn('[engine-setup] INSTALLATION_RECOVERY_REQUIRED')
      })
      child.once('error', (error: Error) => settle({ state: 'failed', request, detail: error.message }))
      return running()
    } catch (error) {
      // A helper may already have dispatched. Parent bookkeeping cannot prove it did not.
      if (dispatched) { console.warn('[engine-setup] INSTALLATION_RECOVERY_REQUIRED'); return recovery() }
      const detail = error instanceof Error ? error.message : String(error)
      try { write(engine, { state: 'failed', request, detail }) } catch { /* said below all the same */ }
      return failed(detail)
    }
  }

  const ensure = async (engine: AgentEngine, _recipe: EngineInstallRecipe, environment: Record<string, string>, request: string,
    current: () => boolean, authorize?: () => Promise<boolean>): Promise<NativeInstallation> => {
    if (!current()) return { complete: false, detail: 'The saved launch request changed before installation.' }
    const record = read(engine)
    if (live(record)) return running()
    if (record && 'dispatch' in record && record.dispatch) return recovery()
    if (record?.request === request && record.state === 'failed') return failed(record.detail ?? 'its installer failed.')
    // Asked again by the launch that installed it, whose look found nothing: another install would find it no better.
    if (record?.request === request && record.state === 'done') return failed('its installer finished, but Harness could not find it. Try again.')
    if (authorize && !await authorize() || !current()) return { complete: false, detail: 'The saved launch request changed before installation.' }
    // Another preparation may have committed while this one waited for core.
    if (JSON.stringify(read(engine)) !== JSON.stringify(record)) return ensure(engine, _recipe, environment, request, current)
    return start(engine, environment, request)
  }

  const status = async (engine: AgentEngine, request: string, _current: () => boolean): Promise<NativeInstallation | null> => {
    const record = read(engine)
    if (live(record)) return running()
    if (record && 'dispatch' in record && record.dispatch) return recovery()
    return record?.request === request && record.state === 'failed' ? failed(record.detail ?? 'its installer failed.') : null
  }

  return { ensure, status }
}
