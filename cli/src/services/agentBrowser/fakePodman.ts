/**
 * A stand-in `podman` for specs: a script in a temp folder that records each call and answers from a table, so no
 * spec ever starts the real Podman (another process may be using it on the machine running the specs).
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FakeReply { stdout?: string; stderr?: string; code?: number; hangMs?: number }
/** `mark` is FAKE_PODMAN_MARK from the environment the call was started with. */
export interface FakeCall { args: string[]; stdin: string; mark?: string }

export interface FakePodman {
  /** The script, to hand to createPodman as where podman was found. */
  readonly path: string
  /** Answers every call whose argv starts with `prefix` (joined by spaces); the longest prefix wins. */
  reply(prefix: string, answer: FakeReply): void
  calls(): FakeCall[]
  /** The process id of the call that read its stdin last. */
  lastPid(): number
  remove(): void
}

// CommonJS on purpose: the temp folder has no package.json, so Node reads the script as CommonJS.
const SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
// As Podman 4.9 does (cmd/podman/secrets/create.go): \`-\` is read only from a real pipe, never a socket or a terminal.
const line = args.join(' ')
if (/(^| )secret create /.test(line) && args.at(-1) === '-' && !fs.fstatSync(0).isFIFO()) {
  process.stderr.write('Error: if \`-\` is used, data must be passed into stdin\\n')
  process.exit(125)
}
const stdin = fs.readFileSync(0, 'utf8')
fs.writeFileSync(path.join(__dirname, 'last.pid'), String(process.pid))
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
  const replies: Record<string, FakeReply> = {}
  const save = () => writeFileSync(join(dir, 'replies.json'), JSON.stringify(replies))
  writeFileSync(path, `#!${process.execPath}\n${SCRIPT}`)
  chmodSync(path, 0o755)
  save()
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
    lastPid: () => Number(readFileSync(join(dir, 'last.pid'), 'utf8')),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  }
}
