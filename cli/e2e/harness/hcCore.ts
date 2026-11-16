/**
 * A Herdr Core (hc) of the test's own (docs/plans/2026-11-16-herdr-app-design.md, "Task 1 findings"), never the
 * person's: a session named `harness-<random>`, its HOME and every XDG_* in a scratch root under /tmp, and its socket a
 * short path there, as sun_path needs. Every hc it runs goes through one wrapper (`hc`) whose environment is built from
 * nothing, so no run of it can reach the person's own core (the default session) or read their settings. It reads no
 * other process's environment.
 *
 * hc starts a core as a one-shot launchd job named after the launching process, which hc removes as the core detaches:
 * no start keeps the core a child of the test (F2). So every start and stop is checked: no `dev.herdr.core.*` job before
 * and after, the private core's pids and socket gone after its own stop, and the person's own cores the same processes
 * throughout. A check that fails throws and names what it found, and no core starts after it in this run. Nothing here
 * ends a process: a private core that will not stop is left for a person to see, and named.
 *
 * Its agent is Node, run by hc with no shell (a shell's return clears the status, F7). It reports `idle` as Claude Code
 * (`claude-code`) once it listens on a socket of its own under the root, and then each word written to that socket as
 * its next status. It prints `fake> `, then `GOT[<line>]` for each line it reads.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { until } from './daemon.js'

const exec = promisify(execFile)

/** The installed hc: ~/.local/bin/herdr-core of the account that runs the tests (`userInfo().homedir`: the suite's HOME is
 *  a throwaway one). Null off macOS, or with none: the file is then skipped. */
export const hcBinary: string | null = (() => {
  if (process.platform !== 'darwin') return null
  const installed = join(userInfo().homedir, '.local', 'bin', 'herdr-core')
  return existsSync(installed) ? installed : null
})()

/** How long a private core has to come up, or to be gone after its stop, before the test says so. */
const SETTLE_MS = 30_000
/** The label prefix of hc's one-shot launchd job (F2). */
const JOB = /^dev\.herdr\.core\./
/** A core as launchd runs it, the person's or ours: `herdr-core --hc-launchd /tmp/hc-launchd-…/ready`. */
const CORE = /herdr-core --hc-launchd /

const AGENT = `import { createServer } from 'node:net'
const say = (state) => process.stdout.write('\\x1b]7501;state=' + state + ':app=claude-code\\x1b\\\\')
createServer((connection) => {
  let read = ''
  connection.on('data', (chunk) => {
    read += chunk
    const newline = read.indexOf('\\n')
    if (newline === -1) return
    say(read.slice(0, newline))
    connection.end('ok\\n')
  })
}).listen(process.argv[2], () => {
  say('idle')
  process.stdout.write('fake> ')
})
let line = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  line += chunk
  for (let newline = line.search(/[\\r\\n]/); newline !== -1; newline = line.search(/[\\r\\n]/)) {
    const got = line.slice(0, newline)
    line = line.slice(newline + 1)
    process.stdout.write('GOT[' + got + ']\\nfake> ')
  }
})
// Its terminal gone, it goes too: its socket's server would keep it running.
process.stdin.on('end', () => process.exit(0))
`

export interface PlannedHc { session: string; socket: string; root: string }
type Status = 'idle' | 'working' | 'blocked' | 'done' | 'error'

/** The first safety check that failed in this run: no core starts after it. */
let refused: Error | undefined
const refuse = (why: string): never => {
  refused ??= new Error(`a private Herdr Core's safety check failed, and no core starts after it: ${why}`)
  throw refused
}

/** The launchd jobs hc names, as `launchctl list` prints them: `launchctl` is run for its list and nothing else. */
async function jobs(): Promise<string[]> {
  const { stdout } = await exec('/bin/launchctl', ['list'])
  return stdout.split('\n').map((line) => line.trim().split(/\s+/)[2] ?? '').filter((label) => JOB.test(label)).sort()
}

/** Every process, by pid: its command line, as `ps` prints it. Never its environment. */
async function processes(): Promise<Map<number, string>> {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 16 * 1024 * 1024 })
  const out = new Map<number, string>()
  for (const line of stdout.split('\n')) {
    const fields = /^\s*(\d+)\s+\d+\s+(.*)$/.exec(line)
    if (fields) out.set(Number(fields[1]), fields[2])
  }
  return out
}

/** The person's own cores, the default session's among them, as they ran before this run's first start. */
let theirs: Map<number, string> | undefined
const ours = new Set<number>()
async function cores(): Promise<Map<number, string>> {
  return new Map([...await processes()].filter(([pid, command]) => CORE.test(command) && !ours.has(pid)))
}
/** The person's cores are the same processes they were. */
async function theirsUnchanged(when: string): Promise<void> {
  const now = await processes()
  for (const [pid, command] of theirs ?? []) {
    if (now.get(pid) !== command) refuse(`the person's own Herdr Core (pid ${pid}) is not the process it was, ${when}`)
  }
}

export class PrivateHc {
  /** The core's pid and its holders', and its agents': each must be gone after its stop. */
  private readonly pids = new Set<number>()
  /** Each agent's own socket, by its terminal's address: a word written there is its next status. */
  private readonly agents = new Map<string, string>()
  private stopped = false

  private constructor(private readonly planned: PlannedHc) {}

  /** A session name and a short socket path of its own, before anything runs: the daemon is started with them. Nothing
   *  is made until `start`. */
  static plan(): PlannedHc {
    const root = `/tmp/hh-${randomBytes(4).toString('hex')}`
    return { session: `harness-${randomBytes(6).toString('hex')}`, socket: join(root, 'c.sock'), root }
  }

  static async start(planned: PlannedHc): Promise<PrivateHc> {
    if (refused) throw refused
    if (!hcBinary) throw new Error('Herdr Core is not installed')
    const before = await jobs()
    if (before.length) refuse(`launchd already holds ${before.join(', ')} before a start`)
    theirs ??= await cores()
    // Its own folder, made here and nowhere else: a root that is already there is someone else's.
    await mkdir(planned.root, { mode: 0o700 })
    const core = new PrivateHc(planned)
    try {
      await core.hc(['server', 'start', '--json'])
      await until('the private Herdr Core to answer', () => core.rpc('hello', { generation: 1 }), SETTLE_MS, 100)
      await core.note()
      await until('launchd to drop the private core\'s start job', async () => (await jobs()).length === 0, SETTLE_MS, 100)
        .catch(async () => refuse(`launchd still holds ${(await jobs()).join(', ')} after a start`))
      await theirsUnchanged('after a start')
    } catch (error) {
      await core.stop().catch(() => { /* the start's own error says more */ })
      throw error
    }
    return core
  }

  /** The one way hc runs here: the installed binary, by its path, in an environment built from nothing. */
  private async hc(args: string[]): Promise<string> {
    const { session, socket, root } = this.planned
    if (!session.startsWith('harness-')) throw new Error(`a private Herdr Core's session must start harness-, not ${session}`)
    const folder = (name: string) => join(root, name)
    for (const name of ['home', 'config', 'data', 'state', 'cache', 'run']) await mkdir(folder(name), { recursive: true, mode: 0o700 })
    const { stdout } = await exec(hcBinary!, args, {
      env: {
        HOME: folder('home'), XDG_CONFIG_HOME: folder('config'), XDG_DATA_HOME: folder('data'), XDG_STATE_HOME: folder('state'),
        XDG_CACHE_HOME: folder('cache'), XDG_RUNTIME_DIR: folder('run'),
        HC_SESSION: session, HC_SOCKET: socket, PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      },
      timeout: 10_000,
    })
    return stdout
  }

  /** The core's pid and its holders', from its own status. */
  private async note(): Promise<void> {
    const status = await this.rpc('server.status')
    for (const pid of [status.pid, ...(status.holders as Array<{ pid?: unknown }> ?? []).map((holder) => holder.pid)]) {
      if (typeof pid === 'number') {
        this.pids.add(pid)
        ours.add(pid)
      }
    }
  }

  /** One request, one connection, no `hello`, as hc takes them (A3): the test's own few lines, not the product's client. */
  rpc(method: string, params: Record<string, unknown> = {}, deadlineMs = 10_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const connection = createConnection({ path: this.planned.socket })
      let read = ''
      const deadline = setTimeout(() => {
        connection.destroy()
        reject(new Error(`the private Herdr Core gave no answer to ${method}`))
      }, deadlineMs)
      connection.on('connect', () => connection.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`))
      connection.on('error', (error) => {
        clearTimeout(deadline)
        reject(error)
      })
      connection.on('data', (chunk: Buffer) => {
        read += chunk.toString('utf8')
        const newline = read.indexOf('\n')
        if (newline === -1) return
        clearTimeout(deadline)
        connection.destroy()
        const answer = JSON.parse(read.slice(0, newline)) as { result?: Record<string, unknown>; error?: { data?: { kind?: string } } }
        if (answer.result) resolve(answer.result)
        else reject(new Error(`the private Herdr Core refused ${method}: ${answer.error?.data?.kind}`))
      })
    })
  }

  /** A terminal Herdr's window would show (`herdr.space`), in <root>/work/<folder>, running the fake agent directly,
   *  reported idle: its address. */
  async agent(folder: string): Promise<string> {
    const { root } = this.planned
    const cwd = join(root, 'work', folder)
    await mkdir(cwd, { recursive: true })
    const script = join(root, 'agent.mjs')
    if (!existsSync(script)) await writeFile(script, AGENT)
    const socket = join(root, `${folder}.sock`)
    const run = await this.rpc('terminal.run', { argv: [process.execPath, script, socket], cwd, labels: { 'herdr.space': 's1' } })
    const address = run.address as string
    this.agents.set(address, socket)
    if (typeof run.pid === 'number') this.pids.add(run.pid)
    // The first terminal starts the core's holder.
    await this.note()
    await until(`the fake agent in ${folder}`, async () => (await this.screen(address)).includes('fake>'), 20_000, 100)
    await this.reported(address, 'idle')
    return address
  }

  /** The fake agent reports that status next, and hc has it. */
  async report(address: string, state: Status): Promise<void> {
    const socket = this.agents.get(address)
    if (!socket) throw new Error(`no fake agent at ${address}`)
    await new Promise<void>((resolve, reject) => {
      const connection = createConnection({ path: socket })
      connection.on('connect', () => connection.write(`${state}\n`))
      connection.on('data', () => connection.end())
      connection.on('close', () => resolve())
      connection.on('error', reject)
    })
    await this.reported(address, state)
  }

  private reported(address: string, state: Status): Promise<unknown> {
    return until(`hc to hold ${address} ${state}`, async () =>
      ((await this.rpc('terminal.get', { terminal: address })).status as { state?: string } | null)?.state === state, 10_000, 50)
  }

  /** What the terminal shows: its screen and history (terminal.read). */
  async screen(address: string): Promise<string> {
    return (await this.rpc('terminal.read', { terminal: address })).text as string
  }

  /** `server.stop` over its own socket, then each check: its socket gone or refusing, its pids gone, and no launchd job.
   *  Its root is removed once the core is gone. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    await this.note().catch(() => { /* not answering: the checks below say whether it is gone */ })
    await this.rpc('server.stop').catch(() => this.hc(['server', 'stop', '--json'])).catch(() => { /* already gone */ })
    const left = async (): Promise<string[]> => {
      const running = await processes()
      const answers = await this.rpc('hello', { generation: 1 }, 1_000).then(() => true, () => false)
      return [
        ...(answers ? [`its socket ${this.planned.socket}`] : []),
        ...[...this.pids].filter((pid) => running.has(pid)).map((pid) => `pid ${pid}`),
        ...await jobs(),
      ]
    }
    await until('the private Herdr Core to be gone', async () => (await left()).length === 0, SETTLE_MS, 200)
      .catch(async () => refuse(`after its stop the private Herdr Core of ${this.planned.root} left ${(await left()).join(', ')}`))
    await theirsUnchanged('after a stop')
    await rm(this.planned.root, { recursive: true, force: true })
  }
}
