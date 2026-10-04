/**
 * A daemon under test: the real daemon from this checkout, booted under a throwaway home with its own
 * data directory, port, private tmux server and fake Claude Code and Codex engines, signed out and with
 * every optional feature that reaches beyond the machine turned off. Nothing it does can touch the
 * person's own daemon, tmux server, transcripts or credentials.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { isolatedTmux, type IsolatedTmux } from '../../src/testing/isolatedTmux.js'

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
export const CLI_ROOT = resolve(here, '../..')

export interface DaemonOptions {
  /** Extra environment for the daemon. */
  env?: Record<string, string>
  /** V8 heap ceiling for the daemon process, MiB. Defaults to Node's own. */
  heapMiB?: number
  /** Models the fake engines report. */
  claudeModel?: string
  codexModel?: string
  /** Boot the core on its own (`__run`) instead of under harnessd's master (`__harnessd`). */
  noMaster?: boolean
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  await new Promise<void>((done) => server.close(() => done()))
  if (!address || typeof address === 'string') throw new Error('no free port')
  return address.port
}

export const until = async <T>(what: string, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 30_000, every = 100): Promise<T> => {
  const deadline = Date.now() + ms
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) { last = error }
    await new Promise((done) => setTimeout(done, every))
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`)
}

export class IsolatedDaemon {
  child: ChildProcess | null = null
  private output = ''

  private constructor(
    readonly root: string,
    readonly tmux: IsolatedTmux,
    readonly port: number,
    readonly env: NodeJS.ProcessEnv,
    readonly options: DaemonOptions,
  ) {}

  static async create(options: DaemonOptions = {}): Promise<IsolatedDaemon> {
    const tmux = await isolatedTmux()
    const root = tmux.root
    const port = await freePort()
    const dirs = {
      home: join(root, 'home'), data: join(root, 'data'), runtime: join(root, 'runtime'), auth: join(root, 'auth'),
      bin: join(root, 'bin'), dsh: join(root, 'dsh'), claudeProjects: join(root, 'claude', 'projects'), codexHome: join(root, 'codex'),
      projects: join(root, 'projects'),
    }
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true })
    const config = {
      port, dataDir: dirs.data, claudeProjectsDir: dirs.claudeProjects, codexHome: dirs.codexHome,
      claudeModel: options.claudeModel, codexModel: options.codexModel,
    }
    const engine = pathToFileURL(join(here, 'fakeEngine.mjs')).href
    for (const name of ['claude', 'codex']) {
      await writeFile(join(dirs.bin, name),
        `#!${process.execPath}\nimport(${JSON.stringify(engine)}).then((m) => m.run(${JSON.stringify(name)}, ${JSON.stringify(config)}))\n`,
        { mode: 0o755 })
    }
    const env: NodeJS.ProcessEnv = {
      ...tmux.env,
      NODE_ENV: 'test',
      HOME: dirs.home,
      // A login shell in a pane must not load anyone's zsh configuration.
      ZDOTDIR: dirs.home,
      PORT: String(port),
      ADAPTER_DATA_DIR: dirs.data,
      ADAPTER_RUNTIME_DIR: dirs.runtime,
      ADAPTER_COMPUTER_ID: 'e2e-computer-0000-0000-000000000001',
      ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
      HARNESS_AUTH_DIR: dirs.auth,
      DSH_DIR: dirs.dsh,
      CLAUDE_PATH: join(dirs.bin, 'claude'),
      CODEX_PATH: join(dirs.bin, 'codex'),
      CLAUDE_PROJECTS_DIR: dirs.claudeProjects,
      CODEX_HOME: dirs.codexHome,
      PATH: `${dirs.bin}:${process.env.PATH}`,
      // Signed out, and nothing reaches beyond the machine.
      BACKEND_WS_URL: 'ws://127.0.0.1:9',
      WEB_URL: 'http://127.0.0.1:9',
      DISABLE_HOOK_INSTALL: 'true',
      ADAPTER_UPDATE_DISABLE: 'true',
      ANALYTICS_ENABLED: 'false',
      RECAP_FORCE: 'false',
      RECAP_WITHOUT_DEVICE: 'false',
      CABLE_DISABLE: 'true',
      CABLE_FW_DISABLE: 'true',
      TERMINAL_BACKENDS: 'tmux',
      TMUX_REAP_INTERVAL_MS: '5000',
      TERMINAL_RECONCILE_INTERVAL_MS: '5000',
      ...options.env,
    }
    return new IsolatedDaemon(root, tmux, port, env, options)
  }

  get dataDir(): string { return this.env.ADAPTER_DATA_DIR! }
  get computerId(): string { return this.env.ADAPTER_COMPUTER_ID! }
  get socketPath(): string { return join(this.dataDir, `daemon-${this.port}.sock`) }
  get projectsDir(): string { return join(this.root, 'projects') }
  /** The process `harness start` would have started: the master, or a core run on its own. */
  get pid(): number | null { return this.child?.pid ?? null }

  /** The core the master is running now (the last one it said it started). */
  corePid(): number | null {
    if (this.options.noMaster) return this.pid
    const started = [...this.output.matchAll(/\[harnessd\] core started \(pid (\d+)\)/g)]
    return started.length ? Number(started[started.length - 1][1]) : null
  }

  /** How many cores the master has started since this daemon object first started one. */
  coresStarted(): number {
    return [...this.output.matchAll(/\[harnessd\] core started/g)].length
  }
  log(): string { return this.output }

  /** `ready: 'port'` returns as soon as the port answers, the way a client sees a restarting daemon;
   *  `'none'` as soon as the process is started. */
  async start(options: { ready?: 'none' | 'port' | 'wired' } = {}): Promise<void> {
    if (this.child) throw new Error('already running')
    const heap = this.options.heapMiB ? [`--max-old-space-size=${this.options.heapMiB}`] : []
    const entry = this.options.noMaster ? '__run' : '__harnessd'
    // Readiness is judged from what this start prints, never from an earlier boot's lines.
    const from = this.output.length
    const child = spawn(process.execPath, [...heap, '--import', 'tsx', 'src/cli.ts', entry], {
      cwd: CLI_ROOT, env: this.env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    const take = (chunk: Buffer) => { this.output += chunk.toString('utf8') }
    child.stdout!.on('data', take)
    child.stderr!.on('data', take)
    const exited = new Promise<never>((_, reject) => child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null
      reject(new Error(`daemon exited during boot (${signal ?? code}):\n${this.output.slice(-4000)}`))
    }))
    exited.catch(() => {}) // observed below while booting; afterwards an exit is the test's business
    if (options.ready === 'none') return
    await Promise.race([exited, (async () => {
      await until('the daemon to answer on its port', async () => {
        const response = await fetch(`http://127.0.0.1:${this.port}/api/health`).catch(() => null)
        return response?.ok ? true : null
      }, 60_000, 200)
      await until('the daemon socket', () => existsSync(this.socketPath), 10_000)
      // The port answers ~1,100 lines of startup before every handler is wired (see the startup-race
      // test); this line is printed once they are.
      if (options.ready !== 'port') {
        await until('the daemon to finish starting', () => /\[cli\] (dialing|not signed in)/.test(this.output.slice(from)), 60_000, 100)
      }
    })()])
  }

  /** SIGTERM, then SIGKILL after `ms`. Resolves when the process is gone. */
  async stop(ms = 15_000): Promise<void> {
    const child = this.child
    if (!child) return
    const exited = new Promise<void>((done) => child.once('exit', () => done()))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), ms)
    await exited
    clearTimeout(timer)
  }

  /** The way a crash ends it: no shutdown path runs. */
  async kill(): Promise<void> {
    const child = this.child
    if (!child) return
    const exited = new Promise<void>((done) => child.once('exit', () => done()))
    child.kill('SIGKILL')
    await exited
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  /** Resident memory of the core, MiB. */
  async rssMiB(): Promise<number> {
    const pid = this.corePid()
    if (!pid) return 0
    const { stdout } = await exec('ps', ['-o', 'rss=', '-p', String(pid)]).catch(() => ({ stdout: '0' }))
    return Number(stdout.trim()) / 1024
  }

  /** Whether a process is alive (signal 0). */
  static alive(pid: number | null): boolean {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }

  /** What the daemon's pane shows, plain text. */
  async capture(pane: string): Promise<string> {
    return this.tmux.run('capture-pane', '-p', '-t', pane)
  }

  hookCredential(): string {
    return readFileSync(join(this.dataDir, 'hook-credential'), 'utf8').trim()
  }

  async close(): Promise<void> {
    await this.stop().catch(() => {})
    await this.tmux.close()
  }
}
