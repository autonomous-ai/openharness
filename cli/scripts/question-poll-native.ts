/** Real, private tmux reads and question/answer flow using recorded dialog paint.
 * No provider, user profile, or existing tmux server is used. Also compares the
 * old per-pane capture with batching; CPU is this Node process, not tmux or the
 * whole app. Run from cli/: node --import tsx scripts/question-poll-native.ts /tmp/result.json
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AskQuestionController, QuestionWatcher, type ShapedQuestion } from '../src/lib/askQuestion.js'
import { TmuxCaptureBatcher, tmuxCaptureArgs } from '../src/lib/tmuxCapture.js'
import type { RegisteredSession } from '../src/lib/registry.js'

const exec = promisify(execFile)
const root = mkdtempSync(join(tmpdir(), 'harness-question-poll-'))
const socket = join(root, 'tmux.sock')
const env = { ...process.env }
delete env.TMUX; delete env.TMUX_PANE
const tmux = async (...args: string[]) => (await exec('tmux', ['-S', socket, ...args], { env, timeout: 5_000 })).stdout
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function eventually(check: () => boolean | Promise<boolean>, label: string, timeout = 6_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await wait(25) }
  throw new Error(`Timed out: ${label}`)
}

let captureProcesses = 0
const batcher = new TmuxCaptureBatcher((args, options, done) => {
  captureProcesses++
  execFile('tmux', ['-S', socket, ...args], { ...options, env }, done)
})
const directCapture = (pane: string, history = 60): Promise<string | null> => new Promise(resolve => {
  captureProcesses++
  execFile('tmux', ['-S', socket, ...tmuxCaptureArgs(pane, history)], { env, timeout: 2_000 },
    (error, text) => resolve(error ? null : text))
})
const panes: string[] = []
const sessions = new Map<string, RegisteredSession>()
let watcher: QuestionWatcher | undefined
const result: Record<string, unknown> = { recordedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`,
  scope: 'Private real tmux with recorded dialog paint. Node CPU excludes tmux clients/server; not whole-app energy.' }

try {
  result.tmux = (await exec('tmux', ['-V'])).stdout.trim()
  const question = readFileSync(resolve('src/lib/__fixtures__/question-single.txt'), 'utf8')
  const helper = join(root, 'dialog.py')
  writeFileSync(helper, String.raw`import os, signal, sys, termios
from pathlib import Path
signal.alarm(180)
attrs = termios.tcgetattr(0)
attrs[3] &= ~(termios.ECHO | termios.ICANON)
attrs[6][termios.VMIN] = 1
attrs[6][termios.VTIME] = 0
termios.tcsetattr(0, termios.TCSANOW, attrs)
text = Path(sys.argv[1]).read_text()
def paint(value):
    sys.stdout.write('\x1b[2J\x1b[3J\x1b[H' + value); sys.stdout.flush()
paint(text)
while True:
    char = os.read(0, 1)
    if not char: break
    if char in (b'1', b'2'): paint('Answered ' + char.decode() + '\n')
    if char == b'q': paint(text)
`)
  for (let i = 0; i < 32; i++) {
    const fixture = join(root, `question-${i}.txt`)
    writeFileSync(fixture, question.replace('Which drink would you like?', `Which drink for pane ${i}?`))
    const command = i < 2 ? ['python3', '-u', helper, fixture]
      : ['/bin/sh', '-c', 'cat "$1"; exec /bin/sleep 180', 'fixture', fixture]
    const pane = (await tmux('-f', '/dev/null', 'new-session', '-d', '-P', '-F', '#{pane_id}',
      '-s', `question-${i}`, '-x', '100', '-y', '35', ...command)).trim()
    assert.match(pane, /^%\d+$/)
    panes.push(pane)
    sessions.set(`s${i}`, { agentId: `s${i}`, sessionId: `s${i}`, engine: 'claude', active: true,
      tmuxPane: pane, runtimes: [{ backend: 'tmux', paneId: pane }] } as RegisteredSession)
  }
  await eventually(async () => {
    const captures = await Promise.all(panes.map(pane => batcher.capture(pane, 60)))
    return captures.every((text, i) => text?.includes(`Which drink for pane ${i}?`))
  }, 'all fixture panes are painted')
  const capture = (target: string, lines?: number) => {
    const pane = sessions.get(target)?.tmuxPane
    return pane ? batcher.capture(pane, lines) : Promise.resolve(null)
  }
  const sendKey = async (target: string, key: string) => {
    const pane = sessions.get(target)?.tmuxPane
    if (!pane) return false
    try { await tmux('send-keys', '-t', pane, key); return true } catch { return false }
  }
  const controller = new AskQuestionController({ getSession: id => sessions.get(id), capture,
    sendKey, sendText: async () => { throw new Error('This fixture must not type free text') } })
  const open = new Map<string, { requestId: string; questions: ShapedQuestion[] }>()
  let announcements = 0
  const gone: string[] = []
  watcher = new QuestionWatcher({ getSession: id => sessions.get(id), capture, hasDevice: () => true,
    isDriving: id => controller.isDriving(id),
    onQuestion: (id, requestId, questions) => { announcements++; controller.remember(requestId, id); open.set(id, { requestId, questions }) },
    onQuestionGone: id => { gone.push(id); open.delete(id) } })
  captureProcesses = 0
  const started = performance.now()
  for (const id of sessions.keys()) watcher.start(id)
  await eventually(() => open.size === 32, 'all questions announce on the first shared tick')
  const firstTickMs = performance.now() - started
  assert.equal(captureProcesses, 1, '32 first-tick question reads use one tmux process')
  for (let i = 0; i < 32; i++) assert.equal(open.get(`s${i}`)?.questions[0].q, `Which drink for pane ${i}?`)
  await wait(1_600)
  assert.equal(announcements, 32, 'an unchanged question announces once')

  const beforeAnswer = open.get('s0')!
  const answered = await controller.answer({ sessionId: 's0', requestId: beforeAnswer.requestId,
    answers: { [beforeAnswer.questions[0].key]: 'Coffee' } })
  if (!answered.ok) console.error('Fixture screen after failed answer:', JSON.stringify(await directCapture(panes[0])))
  assert.deepEqual(answered, { ok: true })
  await eventually(() => gone.includes('s0'), 'answered question closes after two valid empty reads')
  assert.equal(gone.filter(id => id === 's0').length, 1)
  assert.equal(open.size, 31, 'neighboring questions remain open')
  assert.match((await directCapture(panes[0]))!, /Answered 2/)
  assert.match((await directCapture(panes[1]))!, /Which drink for pane 1/)
  assert.equal((await controller.answer({ sessionId: 's0', requestId: beforeAnswer.requestId,
    answers: { [beforeAnswer.questions[0].key]: 'Coffee' } })).ok, false, 'an answered request is stale')

  await tmux('send-keys', '-t', panes[0], 'q')
  await eventually(() => open.has('s0'), 'question reopens after a screen change')
  const beforeMissing = open.size
  await tmux('kill-pane', '-t', panes[16])
  await wait(3_100)
  assert.equal(open.size, beforeMissing, 'failed reads are not a confirmed question close')
  const missingBatch = await Promise.all([panes[0], panes[16], panes[31]].map(pane => batcher.capture(pane, 60)))
  assert.match(missingBatch[0]!, /Which drink for pane 0/)
  assert.equal(missingBatch[1], null)
  assert.match(missingBatch[2]!, /Which drink for pane 31/)
  sessions.delete('s16'); watcher.stop('s16')
  assert.equal(open.size, 31)
  watcher.stopAll()
  const capturesAtStop = captureProcesses
  await wait(1_600)
  assert.equal(captureProcesses, capturesAtStop, 'no tmux polling after stopAll')
  result.endToEnd = { result: 'passed', sessions: 32, firstTickProcesses: 1, firstTickMs,
    checks: ['question identity', 'deduplication', 'answer routing', 'two-read close', 'stale answer refusal',
      'question reopens', 'missing-pane isolation', 'unknown capture preservation', 'poll teardown'] }

  // The killed pane is replaced by another live pane in the benchmark's input.
  // The old and new captures still receive identical ordered targets.
  const targets = panes.map((pane, i) => i === 16 ? panes[31] : pane)
  const reference = await Promise.all(targets.map(pane => directCapture(pane)))
  const samples: Array<Record<string, unknown>> = []
  for (const count of [1, 8, 32]) {
    const selected = targets.slice(0, count)
    for (let warm = 0; warm < 5; warm++) {
      await Promise.all(selected.map(pane => directCapture(pane)))
      await Promise.all(selected.map(pane => batcher.capture(pane, 60)))
    }
    for (let iteration = 0; iteration < 30; iteration++) {
      for (const mode of iteration % 2 ? ['batched', 'direct'] : ['direct', 'batched']) {
        captureProcesses = 0
        const cpu = process.cpuUsage()
        const start = performance.now()
        const screens = await Promise.all(selected.map(pane => mode === 'direct' ? directCapture(pane) : batcher.capture(pane, 60)))
        const elapsedMs = performance.now() - start
        const used = process.cpuUsage(cpu)
        assert.deepEqual(screens, reference.slice(0, count), 'capture bytes and target order stay identical')
        samples.push({ count, mode, iteration, elapsedMs, nodeCpuMs: (used.user + used.system) / 1000, processes: captureProcesses })
      }
    }
  }
  result.benchmark = { warmups: 5, iterations: 30, samples }
  const summary = [1, 8, 32].map(count => Object.fromEntries(['count', 'direct', 'batched'].map(mode => {
    if (mode === 'count') return [mode, count]
    const rows = samples.filter(row => row.count === count && row.mode === mode)
    const elapsed = rows.map(row => row.elapsedMs as number).sort((a, b) => a - b)
    return [mode, { medianMs: (elapsed[14] + elapsed[15]) / 2,
      nodeCpuMs: rows.reduce((sum, row) => sum + (row.nodeCpuMs as number), 0),
      processes: rows.reduce((sum, row) => sum + (row.processes as number), 0) }]
  })))
  result.summary = summary
  const output = process.argv[2]
  if (output) writeFileSync(resolve(output), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ endToEnd: result.endToEnd, summary }, null, 2))
} finally {
  watcher?.stopAll()
  const missingServer = (error: unknown) => /no server running|error connecting.*(?:No such file|Connection refused)/i
    .test(String((error as { stderr?: string }).stderr ?? error))
  const fixturePids = (await tmux('list-panes', '-a', '-F', '#{pane_pid}').catch(error => {
    if (!missingServer(error)) throw error
    return ''
  })).trim().split('\n').filter(Boolean).map(Number)
  await tmux('kill-server').catch(error => { if (!missingServer(error)) throw error })
  await eventually(() => fixturePids.every(pid => {
    try { process.kill(pid, 0); return false } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      return true
    }
  }), 'all private fixture processes exit')
  // Explicit socket on every command: cleanup can never address a user's server.
  rmSync(root, { recursive: true, force: true })
  console.log(`[question-native] cleaned ${fixturePids.length} private pane processes`)
}
