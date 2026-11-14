/**
 * A stand-in `podman` for specs: a script in a temp folder that records each call and answers from a table, so no
 * spec ever starts the real Podman (another process may be using it on the machine running the specs).
 */
import type * as ChildProcesses from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Each fake's script path: whether it was removed, and its children still running. */
const fakes = new Map<string, { removed: boolean; running: Set<ChildProcess> }>()

/**
 * node:child_process for a spec that starts fakes, installed with
 * `vi.mock('node:child_process', async (real) => (await import('./fakePodman.js')).trackingFakes(await real()))`.
 * Each child that runs a fake, directly or as the stdin relay's `$0`, is kept until it exits, so `remove` waits for
 * it; a removed fake is never started again, as a podman that is gone. A spec's service went on restarting a browser
 * after the spec ended, and its teardown deleted the fake's folder under a running fake (CI, 2026-11-10).
 */
export function trackingFakes(real: typeof ChildProcesses): typeof ChildProcesses {
  const started = <T extends (...args: never[]) => ChildProcess>(start: T): T => ((file: string, args: string[], ...rest: unknown[]) => {
    const fake = [file, ...args].map(arg => fakes.get(arg)).find(Boolean)
    if (fake?.removed) throw Object.assign(new Error(`spawn ${file} ENOENT: the fake podman was removed`), { code: 'ENOENT' })
    const child = (start as unknown as (...all: unknown[]) => ChildProcess)(file, args, ...rest)
    // A child that failed to start has no pid and never exits.
    if (fake && child.pid !== undefined) {
      fake.running.add(child)
      child.once('exit', () => fake.running.delete(child))
    }
    return child
  }) as unknown as T
  return { ...real, spawn: started(real.spawn) }
}

export interface FakeReply { stdout?: string; stderr?: string; code?: number; hangMs?: number }
/** `mark` is FAKE_PODMAN_MARK from the environment the call was started with. */
export interface FakeCall { args: string[]; stdin: string; mark?: string }

export interface FakePodman {
  /** The script, to hand to createPodman as where podman was found. */
  readonly path: string
  /** Answers every call whose argv starts with `prefix` (joined by spaces); the longest prefix wins. */
  reply(prefix: string, answer: FakeReply): void
  calls(): FakeCall[]
  /**
   * The process id of every call, in the order they started, logged before a call reads its stdin: a `podman events`,
   * whose stdin stays open, is in it too.
   */
  pids(): number[]
  /** Starts no more calls, waits for the running ones to exit, then deletes the folder. */
  remove(): Promise<void>
}

// CommonJS on purpose: the temp folder has no package.json, so Node reads the script as CommonJS.
const SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(path.join(__dirname, 'pids.log'), process.pid + '\\n')
// As Podman 4.9 does (cmd/podman/secrets/create.go): \`-\` is read only from a real pipe, never a socket or a terminal.
const line = args.join(' ')
if (/(^| )secret create /.test(line) && args.at(-1) === '-' && !fs.fstatSync(0).isFIFO()) {
  process.stderr.write('Error: if \`-\` is used, data must be passed into stdin\\n')
  process.exit(125)
}
const stdin = fs.readFileSync(0, 'utf8')
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ args, stdin, mark: process.env.FAKE_PODMAN_MARK }) + '\\n')
const table = JSON.parse(fs.readFileSync(path.join(__dirname, 'replies.json'), 'utf8'))
const key = Object.keys(table).filter(k => line === k || line.startsWith(k + ' ')).sort((a, b) => b.length - a.length)[0]
const reply = key === undefined ? {} : table[key]
setTimeout(() => {
  process.stdout.write(reply.stdout || '')
  process.stderr.write(reply.stderr || '')
  process.exitCode = reply.code || 0
}, reply.hangMs || 0)
`

export function fakePodman(): FakePodman {
  const dir = mkdtempSync(join(tmpdir(), 'fake-podman-'))
  const path = join(dir, 'podman')
  const fake = { removed: false, running: new Set<ChildProcess>() }
  fakes.set(path, fake)
  const replies: Record<string, FakeReply> = {}
  const save = () => writeFileSync(join(dir, 'replies.json'), JSON.stringify(replies))
  writeFileSync(path, `#!${process.execPath}\n${SCRIPT}`)
  chmodSync(path, 0o755)
  save()
  writeFileSync(join(dir, 'pids.log'), '')
  return {
    path,
    reply(prefix, answer) {
      replies[prefix] = answer
      save()
    },
    calls() {
      const log = join(dir, 'calls.jsonl')
      if (!existsSync(log)) return []
      return readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as FakeCall)
    },
    pids: () => readFileSync(join(dir, 'pids.log'), 'utf8').split('\n').filter(Boolean).map(Number),
    async remove() {
      fake.removed = true
      await Promise.all([...fake.running].map(child => new Promise(done => child.once('exit', done))))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
