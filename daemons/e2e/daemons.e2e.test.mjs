/**
 * Daemons, end to end, in the sandbox (daemons/e2e/sandbox.mjs): a real backend on a throwaway MongoDB, a real
 * harnessd on a private tmux server, the scripted engine (fake-claude.mjs), and this file as the window. Opt-in:
 *
 *   HARNESS_DAEMONS_E2E=1 E2E_DIR=<empty scratch folder> node --test daemons/e2e/daemons.e2e.test.mjs
 *
 * Mixed versions also need builds of an older ref (daemons/e2e/build-ref.sh origin/main <dir>):
 *
 *   E2E_OLD_CLI=<dir>/cli E2E_OLD_BACKEND=<dir>/backend
 *
 * And the desktop's own zoo client (desktop_zoo_e2e_test.dart), in a desktop build that has the daemons client:
 *
 *   E2E_DESKTOP=<that build>/desktop E2E_FLUTTER=<flutter binary>
 *
 * The sandbox is brought up by the first test and taken down after the last (E2E_KEEP=1 leaves it up). Results,
 * one row per scenario, go to $E2E_DIR/results.json and the end of the output. Some scenarios wait on purpose:
 * harnessd says at most one unsolicited line every two minutes, and reports turns once a minute.
 * docs/research/2026-09-27-daemons-e2e.md has what each one checks and what was found.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect, http, REPO, sandboxState, sleep, until } from './client.mjs'

const ON = process.env.HARNESS_DAEMONS_E2E === '1' && !!process.env.E2E_DIR
const E2E = process.env.E2E_DIR
const OLD_CLI = process.env.E2E_OLD_CLI
const OLD_BACKEND = process.env.E2E_OLD_BACKEND
const ONLY = process.env.E2E_ONLY ? new Set(process.env.E2E_ONLY.split(',')) : null

const results = []
function record(id, title, status, detail) {
  results.push({ id, title, status, detail: detail ?? '' })
  console.log(`# ${status.toUpperCase()} ${id} ${title}${detail ? ` · ${detail}` : ''}`)
}
/** One scenario: a test whose outcome is also a row of the results table. */
function scenario(id, title, fn, opts = {}) {
  const skip = !ON ? 'Set HARNESS_DAEMONS_E2E=1 and E2E_DIR.' : (ONLY && !ONLY.has(id) && !ONLY.has(id.split('.')[0])) ? 'not in E2E_ONLY' : opts.skip
  test(`${id} ${title}`, { skip, timeout: opts.timeout ?? 10 * 60_000 }, async () => {
    const notes = []
    try {
      await fn((line) => notes.push(line))
      record(id, title, 'pass', notes.join('; '))
    } catch (err) {
      record(id, title, 'fail', `${err instanceof Error ? err.message : err}${notes.length ? ` · ${notes.join('; ')}` : ''}`)
      throw err
    }
  })
}

// ── the sandbox ──────────────────────────────────────────────────────────────────────────────────────
function sandbox(...argv) {
  const r = spawnSync(process.execPath, [join(REPO, 'daemons', 'e2e', 'sandbox.mjs'), ...argv], { env: { ...process.env, E2E_DIR: E2E, TMUX: '' }, encoding: 'utf8', timeout: 10 * 60_000 })
  if (r.status !== 0) throw new Error(`sandbox ${argv.join(' ')}: ${r.stderr || r.stdout}`)
  return r.stdout
}
let state = null
const S = () => state ?? (state = sandboxState(E2E))
const refresh = () => { state = sandboxState(E2E); return state }

function requests(since = 0) {
  const file = join(E2E, 'logs', 'requests.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.at >= since)
}
const zooReads = (since) => requests(since).filter((r) => r.kind === 'http' && r.path === '/api/zoo')
const zooOps = (since) => requests(since).filter((r) => r.kind === 'http' && r.path === '/api/zoo/ops')
const zooChangedDown = (since) => requests(since).filter((r) => r.kind === 'ws' && r.dir === 'down' && r.type === 'zoo_changed')

function tmux(...argv) {
  const r = spawnSync(join(E2E, 'bin', 'tmux'), argv, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(E2E, 'home') } })
  return r.stdout ?? ''
}
/** The daemon_* frames harnessd pushes on its own (not the answers to what this window asked). */
const pushed = (win) => win.frames.filter((f) => f.type.startsWith('daemon_') && !f.type.endsWith('_result'))
const capture = (pane) => tmux('capture-pane', '-p', '-J', '-t', pane, '-S', '-40')

// ── harnesses running the scripted engine ────────────────────────────────────────────────────────────
function projectDir(name) { const dir = join(E2E, 'work', name); mkdirSync(dir, { recursive: true }); return dir }
function ctl(project, op) { appendFileSync(join(project, '.fake-claude', 'ctl.jsonl'), JSON.stringify(op) + '\n') }
function jsonl(file) { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
const keysOf = (project, since = 0) => jsonl(join(project, '.fake-claude', 'keys.jsonl')).filter((k) => k.at >= since)
const eventsOf = (project, since = 0) => jsonl(join(project, '.fake-claude', 'events.jsonl')).filter((e) => e.at >= since)

async function harness(win, name, extra = {}, cwd = null) {
  const project = cwd ?? projectDir(name)
  let created
  // A harnessd still booting answers agent_create UNSUPPORTED_ON_REMOTE (the handler is wired late): ask again.
  for (let tries = 0; ; tries++) {
    created = await win.request('agent_create', { engine: 'claude', cwd: project, permissionMode: 'ask', name, ...extra }, 60_000)
    if (created.error !== 'UNSUPPORTED_ON_REMOTE' || tries >= 60) break
    if (tries === 0) console.log(`# agent_create answered UNSUPPORTED_ON_REMOTE while harnessd was booting; retrying`)
    await sleep(1000)
  }
  assert.ok(created.agent?.id, `agent_create: ${JSON.stringify(created).slice(0, 300)}`)
  const agentId = created.agent.id
  await until(`${name} registered`, async () => {
    const list = await win.request('agents_list', {})
    return list.agents?.find((a) => a.id === agentId && a.sessionId)
  }, 30_000, 300)
  await until(`${name} session hook`, () => eventsOf(project).some((e) => e.kind === 'session-start-hook'), 15_000)
  return { name, agentId, project, pane: created.agent.tmuxPane }
}

/**
 * One prompt, and the turn it starts, to its end — and past harnessd's Stop-hook grace (1.5 s): a prompt sent
 * sooner can be force-closed by the previous turn's Stop hook (see A13).
 */
async function turn(h, text, since = Date.now()) {
  ctl(h.project, { op: 'prompt', text })
  const ended = await until(`turn "${text}" ended`, () => eventsOf(h.project, since).find((e) => e.kind === 'turn-end' && e.text === text), 30_000)
  await sleep(2_000)
  return ended
}

// ── the zoo, read through harnessd as a window reads it, and seeded in the sandbox database ──────────
async function zoo() {
  const r = await http(S(), 'GET', '/api/zoo')
  assert.equal(r.status, 200, `GET /api/zoo: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)
  return r.body.data
}
async function ops(list) {
  const r = await http(S(), 'POST', '/api/zoo/ops', { ops: list })
  assert.equal(r.status, 200, `POST /api/zoo/ops: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`)
  return r.body.data
}
let prisma = null
async function db() {
  if (prisma) return prisma
  const mod = await import(join(REPO, 'backend', 'node_modules', '@prisma', 'client', 'index.js'))
  const { PrismaClient } = mod.default ?? mod
  prisma = new PrismaClient({ datasources: { db: { url: `mongodb://127.0.0.1:${S().ports.mongo}/harness_e2e?replicaSet=rs0&directConnection=true` } } })
  return prisma
}
/** Change the account's stored zoo directly (what `zoo.turn` would take days to reach). */
async function seedZoo(mutate) {
  const client = await db()
  const row = await client.zoo.findUnique({ where: { userId: S().user.id } })
  const next = mutate(structuredClone(row.state))
  await client.zoo.update({ where: { userId: S().user.id }, data: { state: next, revision: row.revision + 1 } })
}

// ── the brain's lines ────────────────────────────────────────────────────────────────────────────────
/** harnessd says at most one unsolicited line (need, fail, auto) every two minutes: wait for the next one. */
let lastUnsolicited = 0
function noteUnsolicited(win) {
  for (const f of win.of('daemon_say')) if (['need', 'fail', 'auto'].includes(f.payload.mood)) lastUnsolicited = Math.max(lastUnsolicited, f.at)
}
async function nextLineSlot(win) {
  noteUnsolicited(win)
  const wait = lastUnsolicited + 2 * 60_000 + 2_000 - Date.now()
  if (wait > 0) { console.log(`# waiting ${Math.round(wait / 1000)} s for harnessd's next unsolicited line`); await sleep(wait) }
}
async function needLine(win, h, since) {
  const say = await win.waitFor((f) => f.type === 'daemon_say' && f.payload.mood === 'need' && f.payload.about?.agentId === h.agentId, 20_000, since)
  lastUnsolicited = Math.max(lastUnsolicited, say.at)
  return say.payload
}
async function question(win, h, since) {
  const q = await win.waitFor((f) => f.type === 'commander_question' && f.agentId === h.agentId, 20_000, since)
  return { requestId: q.payload.requestId, key: q.payload.questions[0].key, options: q.payload.questions[0].options }
}
/**
 * The dial's (and cable's) way to answer: `question_response` whose requestId IS the question's id, answered by
 * `question_response_result` under that same id.
 */
async function answerLikeTheDial(win, h, q, choice) {
  const since = Date.now()
  const result = win.waitFor((f) => f.type === 'question_response_result' && f.payload?.requestId === q.requestId, 15_000, since)
  win.send('question_response', { requestId: q.requestId, agentId: h.agentId, answers: { [q.key]: choice } })
  // A harnessd from before STALE_QUESTION (origin/main) answers nothing: the pane is the proof then.
  try { return (await result).payload } catch { return { noReply: true } }
}
const lessonDir = () => join(E2E, 'home', '.harness', 'lessons')
function harnessCli(cliDir, ...argv) {
  const env = {}
  for (const line of sandbox('env').split('\n')) {
    const m = /^export (\w+)=(.*)$/.exec(line)
    if (m) env[m[1]] = JSON.parse(m[2])
  }
  return spawnSync(process.execPath, [join(cliDir, 'dist', 'cli.js'), ...argv], { env, encoding: 'utf8', cwd: join(E2E, 'run'), timeout: 60_000 })
}

/**
 * The desktop's zoo client (desktop_zoo_e2e_test.dart, copied into E2E_DESKTOP/test) against this harnessd:
 * `on` must show the account's zoo, `off` must draw nothing. Null when no desktop build was given.
 */
const DESKTOP = process.env.E2E_DESKTOP
const FLUTTER = process.env.E2E_FLUTTER ?? 'flutter'
function desktopCheck(expect) {
  if (!DESKTOP) return null
  const test = join(DESKTOP, 'test', 'desktop_zoo_e2e_test.dart')
  writeFileSync(test, readFileSync(join(REPO, 'daemons', 'e2e', 'desktop_zoo_e2e_test.dart')))
  const r = spawnSync(FLUTTER, ['test', 'test/desktop_zoo_e2e_test.dart'], {
    cwd: DESKTOP, encoding: 'utf8', timeout: 10 * 60_000,
    env: { ...process.env, TMUX: '', HARNESS_DAEMONS_E2E_PORT: String(S().ports.daemon), HARNESS_DAEMONS_E2E_EXPECT: expect },
  })
  const line = /zoo: [^\n]*/.exec(r.stdout ?? '')?.[0] ?? (r.stderr || r.stdout || '').trim().split('\n').pop()
  return { ok: r.status === 0, line }
}
function desktopNote(note, expect) {
  const d = desktopCheck(expect)
  if (!d) { note('desktop: not run (set E2E_DESKTOP)'); return }
  note(`desktop (${expect}): ${d.ok ? 'pass' : 'FAIL'} · ${d.line}`)
  assert.ok(d.ok, `the desktop's zoo client with daemons ${expect}: ${d.line}`)
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
if (!ON) {
  test('daemons sandbox e2e', { skip: 'Set HARNESS_DAEMONS_E2E=1 and E2E_DIR to run it (it needs docker and tmux).' }, () => {})
} else {
  before(() => { sandbox('up', '--daemons', 'on', '--backend', join(REPO, 'backend'), '--cli', join(REPO, 'cli')); refresh() })
  after(async () => {
    try { await prisma?.$disconnect() } catch { /* gone */ }
    writeFileSync(join(E2E, 'results.json'), JSON.stringify(results, null, 2) + '\n')
    console.log('\n| id | scenario | result | detail |\n|---|---|---|---|')
    for (const r of results) console.log(`| ${r.id} | ${r.title} | ${r.status} | ${r.detail.replace(/\|/g, '/').slice(0, 400)} |`)
    if (process.env.E2E_KEEP !== '1') sandbox('down')
  })

  describe('daemons on: a new harnessd against a new backend', { concurrency: false }, () => {
    let win
    let alpha
    before(async () => { win = await connect(S()) })
    after(async () => { await win?.close() })

    scenario('A1', 'harnessd probes GET /api/zoo at start and switches daemons on', async (note) => {
      const since = S().harnessd.spawnAt
      await sleep(3000)
      const reads = zooReads(since)
      // The probe, then (once on) the zoo is re-read on every backend connect, the first one included.
      note(`${reads.length} GET /api/zoo at start (${reads.map((r) => r.status).join(',')})`)
      assert.ok(reads.length >= 1 && reads.length <= 2)
      assert.equal(reads[0].status, 200)
      const status = (await http(S(), 'GET', '/api/status')).body
      assert.deepEqual(status.daemons, { on: true, server: 'on', killed: false })
    })

    scenario('A2', 'habits grant the first egg; the server hatches it with a serial; consent turns the sensor on', async (note) => {
      const before0 = await zoo()
      assert.equal(before0.zoo.daemons.length, 0, 'a fresh account has no daemons')
      const habits = await ops([{ op: 'zoo.habit', key: 'turn' }, { op: 'zoo.habit', key: 'split' }])
      assert.equal(habits.grants.length, 0, 'two habits are not enough')
      const third = await ops([{ op: 'zoo.habit', key: 'find' }])
      assert.equal(third.grants.length, 1)
      assert.equal(third.grants[0].kind, 'first')
      const since = Date.now()
      const hatched = await ops([{ op: 'zoo.hatch', eggId: third.grants[0].eggId }])
      const h0 = hatched.hatched[0]
      note(`hatched ${h0.daemonId} serial #${h0.serial}${h0.shiny ? ' shiny' : ''}`)
      assert.ok(h0.daemonId && Number.isInteger(h0.serial) && h0.serial >= 1)
      assert.equal(hatched.zoo.pair, h0.daemonId, 'the first daemon pairs itself')
      await win.waitFor((f) => f.type === 'zoo_changed', 5_000, since)
      // Before consent nothing is watched.
      const s0 = await win.request('daemon_act', { id: 'need:none', choice: 'y' })
      assert.ok(s0.error, 'no line to act on')
      const consentAt = Date.now()
      const consented = await ops([{ op: 'zoo.consent', watching: true }])
      assert.equal(consented.zoo.consent.watching, true)
      assert.equal(consented.zoo.autonomy, 'watch')
      // The window attached before pairing came on: does it hear daemon_state now?
      let heard = true
      try { await win.waitFor((f) => f.type === 'daemon_state' && f.payload.pair === h0.daemonId, 6_000, consentAt) } catch { heard = false }
      note(heard ? 'daemon_state reached the attached window' : 'BUG: no daemon_state to the window attached when pairing came on')
      const fresh = await connect(S())
      const st = await fresh.waitFor((f) => f.type === 'daemon_state', 5_000)
      await fresh.close()
      assert.equal(st.payload.pair, h0.daemonId)
      assert.equal(st.payload.autonomy, 'watch')
      alpha = await harness(win, 'alpha')
      assert.equal(heard, true, 'a window attached when pairing came on is sent daemon_state')
    })

    scenario('A3', 'at watch a need line carries only [g], and y answers nothing', async (note) => {
      alpha ??= await harness(win, 'alpha')
      await nextLineSlot(win)
      const since = Date.now()
      ctl(alpha.project, { op: 'prompt', text: 'e2e:bash npm test' })
      const say = await needLine(win, alpha, since)
      note(`line "${say.line}"`)
      assert.deepEqual(say.actions.map((a) => a.key), ['g'])
      win.send('daemon_shown', { id: say.id })
      await sleep(450)
      const r = await win.request('daemon_act', { id: say.id, choice: 'y' })
      note(`y → ${r.error}`)
      assert.equal(r.ok, false)
      assert.equal(keysOf(alpha.project, since).length, 0, 'nothing typed')
      const q = await question(win, alpha, since)
      const answered = await answerLikeTheDial(win, alpha, q, 'Yes')
      assert.equal(answered.ok, true, JSON.stringify(answered))
      await until('turn ended', () => eventsOf(alpha.project, since).some((e) => e.kind === 'turn-end'), 15_000)
    })

    scenario('A4', 'turns are reported as zoo.turn; the server grants a turn egg and levels the pair up', async (note) => {
      alpha ??= await harness(win, 'alpha')
      // Days of work in a moment: 39 counted turns and 148 xp, so one more turn earns the egg and level 2 (1.0).
      await seedZoo((z) => {
        z.progress.turns = 39
        z.progress.days = {}
        z.daemons = z.daemons.map((d) => (d.id === z.pair ? { ...d, xp: 148, bond: 1, version: '0.1' } : d))
        return z
      })
      const since = Date.now()
      await turn(alpha, 'count this turn', since)
      const op = await until('a zoo.turn report', () => zooOps(since).find((r) => r.ops?.includes('zoo.turn')), 90_000, 1000)
      note(`zoo.turn sent ${Math.round((op.at - since) / 1000)} s after the turn (status ${op.status})`)
      assert.equal(op.status, 200)
      const after0 = await zoo()
      const pair = after0.zoo.daemons.find((d) => d.id === after0.zoo.pair)
      note(`turns ${after0.zoo.progress.turns}, ${after0.zoo.pair} xp ${pair.xp} bond ${pair.bond} v${pair.version}, eggs ${after0.zoo.eggs.map((e) => e.kind).join(',')}`)
      assert.ok(after0.zoo.progress.turns >= 40)
      assert.ok(after0.zoo.eggs.some((e) => e.kind === 'turn'), 'a turn egg every 40 counted turns')
      assert.equal(pair.bond, 2)
      assert.equal(pair.version, '1.0')
      await win.waitFor((f) => f.type === 'zoo_changed', 5_000, since)
      assert.ok(zooChangedDown(since).length >= 1, 'zoo_changed came down the adapter socket')
    })

    scenario('A5', 'a duplicate merges into the daemon you have: +150 xp, dupes 1, no serial', async (note) => {
      await seedZoo((z) => {
        const owned = new Set(z.daemons.map((d) => d.id))
        for (const id of ['tim', 'fish', 'ping', 'bat', 'vim', 'zsh', 'biff', 'fzf', 'tldr']) {
          if (!owned.has(id)) z.daemons.push({ id, hatchedAt: new Date().toISOString(), egg: 'turn', shiny: false, bond: 0, xp: 0, version: '0.1' })
        }
        z.eggs = [...z.eggs.filter((e) => e.id !== 'e2edup0001'), { id: 'e2edup0001', kind: 'turn', grantedAt: new Date().toISOString() }]
        return z
      })
      const before0 = (await zoo()).zoo
      const hatched = await ops([{ op: 'zoo.hatch', eggId: 'e2edup0001' }])
      const h0 = hatched.hatched[0]
      note(`hatched ${h0.daemonId} duplicate=${h0.duplicate} xp=${h0.xp}`)
      assert.equal(h0.duplicate, true)
      assert.equal(h0.xp, 150)
      assert.equal(h0.serial, undefined)
      const was = before0.daemons.find((d) => d.id === h0.daemonId)
      const now = hatched.zoo.daemons.find((d) => d.id === h0.daemonId)
      assert.equal(now.xp, was.xp + 150)
      assert.equal(now.dupes ?? 0, (was.dupes ?? 0) + 1)
      assert.equal(hatched.zoo.daemons.filter((d) => d.id === h0.daemonId).length, 1, 'one record per daemon')
    })

    scenario('D1', 'desktop: the zoo client shows the account\'s zoo when daemons are on', async (note) => {
      desktopNote(note, 'on')
    }, { skip: DESKTOP ? undefined : 'Set E2E_DESKTOP (a desktop build with the daemons client) and E2E_FLUTTER.' })

    scenario('A6', 'suggest: [y/n/g] with the whole dialog; NOT_SHOWN, TOO_SOON, LOCAL_SOCKET_REQUIRED, UI_ONLY, then y types one key', async (note) => {
      alpha ??= await harness(win, 'alpha')
      const set = await ops([{ op: 'zoo.autonomy', level: 'suggest' }])
      assert.equal(set.zoo.autonomy, 'suggest')
      const tcp = await connect(S(), { transport: 'tcp' })
      const tool = await connect(S(), { tool: true })
      try {
        await nextLineSlot(win)
        const since = Date.now()
        ctl(alpha.project, { op: 'prompt', text: 'e2e:bash npm test' })
        const say = await needLine(win, alpha, since)
        note(`line "${say.line}"`)
        assert.deepEqual(say.actions.map((a) => a.key), ['y', 'n', 'g'])
        assert.match(say.detail, /npm test/)
        assert.match(say.detail, /Do you want to proceed\?/)
        const notShown = await win.request('daemon_act', { id: say.id, choice: 'y' })
        assert.equal(notShown.error, 'NOT_SHOWN')
        const overTcp = await tcp.request('daemon_act', { id: say.id, choice: 'y' })
        assert.equal(overTcp.error, 'LOCAL_SOCKET_REQUIRED')
        const byTool = await tool.request('daemon_act', { id: say.id, choice: 'y' })
        assert.equal(byTool.error, 'UI_ONLY')
        win.send('daemon_shown', { id: say.id })
        const tooSoon = await win.request('daemon_act', { id: say.id, choice: 'y' })
        assert.equal(tooSoon.error, 'TOO_SOON')
        await sleep(450)
        const yes = await win.request('daemon_act', { id: say.id, choice: 'y' })
        assert.equal(yes.ok, true, JSON.stringify(yes))
        await until('the answer reached the pane', () => eventsOf(alpha.project, since).some((e) => e.kind === 'approved'), 10_000)
        const keys = keysOf(alpha.project, since)
        note(`keys typed: ${JSON.stringify(keys.map((k) => k.key))}`)
        assert.deepEqual(keys.map((k) => k.key), ['1'], 'exactly one key: the one-time yes')
        assert.match(capture(alpha.pane), /approved: npm test/)
        await win.waitFor((f) => f.type === 'daemon_unsay' && f.payload.id === say.id, 10_000, since)
        await win.waitFor((f) => f.type === 'commander_question_close' && f.agentId === alpha.agentId, 10_000, since)
      } finally { await tcp.close(); await tool.close() }
    })

    scenario('A7', 'deny-class: git push is waiting in daemon_state with deny, and its line (if said) has no [y]', async (note) => {
      alpha ??= await harness(win, 'alpha')
      const since = Date.now()
      ctl(alpha.project, { op: 'prompt', text: 'e2e:bash git push origin main' })
      const q = await question(win, alpha, since)
      const st = await win.waitFor((f) => f.type === 'daemon_state' && f.payload.needs?.some((n) => n.requestId === q.requestId), 10_000, since)
      const need = st.payload.needs.find((n) => n.requestId === q.requestId)
      note(`needs[]: deny=${need.deny} allow=${need.allow}`)
      assert.equal(need.deny, true)
      assert.equal(need.allow, false)
      const say = win.of('daemon_say', since).find((f) => f.payload.about?.requestId === q.requestId)
      if (say) {
        note(`line "${say.payload.line}"`)
        assert.ok(!say.payload.actions.some((a) => a.key === 'y'), 'no [y] on a deny-class prompt')
      } else note('no line (inside the two-minute gap)')
      const declined = await answerLikeTheDial(win, alpha, q, 'No')
      assert.equal(declined.ok, true, JSON.stringify(declined))
      await until('declined', () => eventsOf(alpha.project, since).some((e) => e.kind === 'declined'), 10_000)
      assert.deepEqual(keysOf(alpha.project, since).map((k) => k.key), ['3'])
    })

    scenario('A8', 'STALE_QUESTION: the dialog changed under a shown line, and nothing is typed', async (note) => {
      alpha ??= await harness(win, 'alpha')
      await nextLineSlot(win)
      const since = Date.now()
      ctl(alpha.project, { op: 'prompt', text: 'e2e:bash npm run lint' })
      const say = await needLine(win, alpha, since)
      win.send('daemon_shown', { id: say.id })
      await sleep(450)
      // Claude moves on to its next tool call: the same place on screen now asks about another command.
      ctl(alpha.project, { op: 'change', command: 'npm run build' })
      await until('the pane changed', () => eventsOf(alpha.project, since).some((e) => e.kind === 'dialog-changed'), 5_000, 20)
      await sleep(60)
      const r = await win.request('daemon_act', { id: say.id, choice: 'y' })
      note(`y after the change → ${r.ok ? 'ok' : r.error}`)
      assert.equal(r.ok, false)
      assert.ok(['STALE_QUESTION', 'GONE'].includes(r.error), r.error)
      if (r.error === 'GONE') note('the watcher saw the change first (GONE); the pane re-check is the other path')
      assert.equal(keysOf(alpha.project, since).length, 0, 'nothing typed into the changed dialog')
      // Clean up the new dialog from the dial's side.
      const q2 = await win.waitFor((f) => f.type === 'commander_question' && f.agentId === alpha.agentId && /npm run build/.test(f.payload.questions?.[0]?.key ?? ''), 10_000, since)
      const q = { requestId: q2.payload.requestId, key: q2.payload.questions[0].key }
      const done = await answerLikeTheDial(win, alpha, q, 'No')
      assert.equal(done.ok, true, JSON.stringify(done))
      await until('turn ended', () => eventsOf(alpha.project, since).some((e) => e.kind === 'turn-end'), 10_000)
    })

    scenario('A9', 'raising the dial to act-on-key waits for daemon_confirm from a window that showed it', async (note) => {
      const since = Date.now()
      const raised = await ops([{ op: 'zoo.autonomy', level: 'act-on-key' }])
      assert.equal(raised.zoo.autonomy, 'act-on-key', 'the account holds the request')
      const st = await win.waitFor((f) => f.type === 'daemon_state' && f.payload.confirms?.some((c) => c.kind === 'autonomy'), 10_000, since)
      assert.equal(st.payload.autonomy, 'suggest', 'harnessd keeps suggest until the person says yes here')
      assert.equal(st.payload.autonomyRequested, 'act-on-key')
      const c = st.payload.confirms.find((x) => x.kind === 'autonomy')
      note(`confirm line "${c.line}"`)
      const early = await win.request('daemon_confirm', { kind: 'autonomy', nonce: c.nonce, accept: true })
      assert.equal(early.error, 'NOT_SHOWN')
      const tcp = await connect(S(), { transport: 'tcp' })
      const overTcp = await tcp.request('daemon_confirm', { kind: 'autonomy', nonce: c.nonce, accept: true })
      await tcp.close()
      assert.equal(overTcp.error, 'LOCAL_SOCKET_REQUIRED')
      win.send('daemon_shown', { id: c.id })
      await sleep(450)
      const ok = await win.request('daemon_confirm', { kind: 'autonomy', nonce: c.nonce, accept: true })
      assert.equal(ok.ok, true, JSON.stringify(ok))
      const st2 = await win.waitFor((f) => f.type === 'daemon_state' && f.payload.autonomy === 'act-on-key', 10_000, since)
      assert.ok(!st2.payload.confirms?.some((x) => x.kind === 'autonomy'))
      const again = await win.request('daemon_confirm', { kind: 'autonomy', nonce: c.nonce, accept: true })
      note(`the same nonce again → ${again.error}`)
      assert.equal(again.ok, false)
    })

    scenario('A10', 'a correction becomes a lesson (model on, confirmed); y teaches it with the nonce; it reaches a Store runtime; lessons revert takes it back', async (note) => {
      alpha ??= await harness(win, 'alpha')
      // The model opt-in is part of pair.jsonc, which applies only once confirmed at a window.
      const since = Date.now()
      writeFileSync(join(E2E, 'home', '.config', 'harness', 'pair.jsonc'), '// e2e\n{ "model": true }\n')
      const st = await win.waitFor((f) => f.type === 'daemon_state' && f.payload.confirms?.some((c) => c.kind === 'rules'), 45_000, since)
      const c = st.payload.confirms.find((x) => x.kind === 'rules')
      win.send('daemon_shown', { id: c.id })
      await sleep(450)
      const ok = await win.request('daemon_confirm', { kind: 'rules', nonce: c.nonce, accept: true })
      assert.equal(ok.ok, true, JSON.stringify(ok))
      note('pair.jsonc { model: true } confirmed')
      // A turn, then the person corrects it.
      const t0 = Date.now()
      await turn(alpha, 'migrate the database', t0)
      await turn(alpha, 'no, always run the migration with --dry-run first and show me the plan', t0)
      const ask = await win.waitFor((f) => f.type === 'daemon_say' && f.payload.mood === 'ask' && String(f.payload.id).startsWith('lesson:'), 5 * 60_000, t0)
      note(`proposed ${Math.round((ask.at - t0) / 1000)} s after the correction: "${ask.payload.line}"`)
      assert.deepEqual(ask.payload.actions.map((a) => a.key), ['y', 'n', 's'])
      assert.match(ask.payload.detail, /run-migrations-safely/)
      const lessonId = String(ask.payload.id).split(':')[1]
      // A tool cannot teach it, and a forged nonce is refused.
      const tool = await connect(S(), { tool: true })
      const byTool = await tool.request('daemon_act', { id: ask.payload.id, choice: 'y' })
      await tool.close()
      assert.equal(byTool.ok, false)
      win.send('daemon_shown', { id: ask.payload.id })
      await sleep(450)
      const forged = await win.request('daemon_act', { id: `lesson:${lessonId}:${'0'.repeat(32)}`, choice: 'y' })
      assert.equal(forged.ok, false)
      const taught = await win.request('daemon_act', { id: ask.payload.id, choice: 'y' })
      note(`y → ${JSON.stringify({ ok: taught.ok, learned: taught.learned, error: taught.error })}`)
      assert.equal(taught.ok, true, JSON.stringify(taught))
      const skill = join(lessonDir(), 'skills', 'run-migrations-safely', 'SKILL.md')
      await until('the skill is in the lessons folder', () => existsSync(skill), 10_000)
      const log = spawnSync('git', ['-C', lessonDir(), 'log', '--format=%s'], { encoding: 'utf8' }).stdout
      assert.match(log, /learn: run-migrations-safely/)
      const credit = await until('zoo.lesson sent', () => zooOps(t0).find((r) => r.ops?.includes('zoo.lesson')), 90_000, 1000)
      note(`zoo.lesson → ${credit.status}`)
      assert.equal(credit.status, 200)
      const z = await zoo()
      assert.ok(z.zoo.progress.lessons.includes(lessonId), 'the lesson id is credited once')
      // Published: a Store harness launched now gets a read-only copy in its runtime, listed in CONTEXT.md.
      const install = harnessCli(join(REPO, 'cli'), 'dsh', 'install', join(REPO, 'store', 'starter'), '--link')
      note(`dsh install starter → ${install.status}`)
      // A lesson from a correction belongs to its project: a Store harness in that folder gets it.
      const store = await harness(win, 'storeharness', { dsh: 'autonomous/starter', permissionMode: 'ask' }, alpha.project)
      const copies = spawnSync('/usr/bin/find', [store.project, join(E2E, 'home', '.harness'), '-path', '*lessons/run-migrations-safely/SKILL.md', '-not', '-path', `${lessonDir()}/*`], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
      note(`runtime copies: ${copies.length}`)
      assert.ok(copies.length >= 1, 'the skill was copied into the Store harness runtime')
      // Taken back with the CLI.
      const reverted = harnessCli(join(REPO, 'cli'), 'pair', 'lessons', 'revert', lessonId, '--json')
      note(`lessons revert → ${reverted.status} ${reverted.stdout.trim().slice(0, 160)}`)
      assert.equal(reverted.status, 0, reverted.stderr)
      assert.ok(!existsSync(skill), 'the skill is gone from skills/')
      const log2 = spawnSync('git', ['-C', lessonDir(), 'log', '--format=%s'], { encoding: 'utf8' }).stdout
      assert.match(log2, /unlearn: run-migrations-safely/)
      await until('withdrawn from the runtime', () => copies.every((file) => !existsSync(file)), 10_000)
    })

    scenario('A11', 'talk: daemon_talk from a window starts the pair harness on the engine and hands it the words', async (note) => {
      const tcp = await connect(S(), { transport: 'tcp' })
      const tool = await connect(S(), { tool: true })
      const overTcp = await tcp.request('daemon_talk', { text: 'hello' })
      const byTool = await tool.request('daemon_talk', { text: 'hello' })
      await tcp.close(); await tool.close()
      assert.equal(overTcp.error, 'LOCAL_SOCKET_REQUIRED')
      assert.equal(byTool.error, 'UI_ONLY')
      const since = Date.now()
      const panesBefore = new Set(tmux('list-panes', '-a', '-F', '#{pane_id}').split('\n').filter(Boolean))
      const talk = await win.request('daemon_talk', { text: 'what is waiting on me?' }, 60_000)
      note(`talk → ${JSON.stringify({ ok: talk.ok, started: talk.started, resumed: talk.resumed, sent: talk.sent, error: talk.error })}`)
      assert.equal(talk.ok, true, JSON.stringify(talk))
      const pane = await until('the pair harness pane', () => tmux('list-panes', '-a', '-F', '#{pane_id} #{pane_current_path}').split('\n').filter(Boolean).find((l) => !panesBefore.has(l.split(' ')[0])), 20_000, 500)
      const cwd = pane.split(' ').slice(1).join(' ')
      const heard = await until('the words reached the pair harness', () => eventsOf(cwd, since).find((e) => e.kind === 'turn-start' && /waiting on me/.test(e.text)), 30_000, 500)
      note(`pair harness in …/${cwd.split('/').slice(-2).join('/')} got "${heard.text}"`)
    })

    scenario('A12', 'question id stability: a ticking timer and cursor moves announce the dialog once, and a dial answer for that id types the keys', async (note) => {
      const timer = await harness(win, 'timer')
      const since = Date.now()
      ctl(timer.project, { op: 'prompt', text: 'e2e:bash-timer npm test' })
      const first = await question(win, timer, since)
      await sleep(4_500)                                  // three ticks of the watcher, four of the timer
      ctl(timer.project, { op: 'cursor', dir: 'down' })
      await sleep(3_000)
      ctl(timer.project, { op: 'cursor', dir: 'up' })
      await sleep(3_000)
      const announced = [...new Set(win.of('commander_question', since).filter((f) => f.agentId === timer.agentId).map((f) => f.payload.requestId))]
      note(`${announced.length} announcement(s) in ${Math.round((Date.now() - since) / 1000)} s`)
      const answer = await answerLikeTheDial(win, timer, first, 'Yes')
      note(`question_response for the first id → ${answer.ok ? 'ok' : answer.error}`)
      const typed = keysOf(timer.project, since).map((k) => k.key)
      note(`keys typed: ${JSON.stringify(typed)}`)
      assert.equal(announced.length, 1, 'announced once')
      assert.equal(answer.ok, true, JSON.stringify(answer))
      assert.deepEqual(typed.filter((k) => /^\d$/.test(k)), ['1'])
    })
  })

  describe('found on the way', { concurrency: false }, () => {
    scenario('A13', 'a prompt queued right behind a turn: its permission question is still announced (pre-existing race, also on main)', async (note) => {
      const win = await connect(S())
      try {
        const h = await harness(win, 'queued')
        const tries = 6
        let missed = 0
        for (let i = 0; i < tries; i++) {
          const since = Date.now()
          // Claude submits a prompt typed while it worked as soon as the turn ends, right after the Stop hook.
          ctl(h.project, { op: 'prompt', text: `a quick one ${i}` })
          ctl(h.project, { op: 'prompt', text: 'e2e:bash npm test' })
          await until('the dialog is up', () => eventsOf(h.project, since).some((e) => e.kind === 'dialog'), 15_000)
          let announced = null
          try { announced = await win.waitFor((f) => f.type === 'commander_question' && f.agentId === h.agentId, 6_000, since) } catch { missed++ }
          // Close the dialog from the pane, whatever happened, and let the Stop-hook grace pass.
          ctl(h.project, { op: 'key', key: '3' })
          await until('closed', () => eventsOf(h.project, since).some((e) => e.kind === 'declined'), 10_000)
          await sleep(2_500)
          void announced
        }
        note(`${tries - missed} of ${tries} queued questions announced${missed ? '; the others were force-closed by the previous turn\'s Stop hook after its grace, and the question watcher stopped with them' : ''}`)
        assert.equal(missed, 0, 'every queued turn\'s question reached the window')
      } finally { await win.close() }
    })
  })

  describe('daemons off', { concurrency: false }, () => {
    scenario('B1', 'server off: one probe (404) per harnessd start, no zoo traffic over many turns, DAEMONS_OFF, no daemon_* frames', async (note) => {
      sandbox('backend', '--daemons', 'off', '--backend', join(REPO, 'backend'))
      let since = Date.now()
      sandbox('harnessd', 'restart', '--cli', join(REPO, 'cli'))
      refresh()
      // The harnessd that stopped (daemons on) flushed its last minute of turns on the way out, into a server
      // that had just been switched off.
      const flushed = zooOps(since).filter((r) => r.at < S().harnessd.spawnAt)
      if (flushed.length) note(`the stopping harnessd's shutdown flush: ${flushed.map((r) => `${r.ops.join('+')} → ${r.status}`).join(', ')}`)
      since = S().harnessd.spawnAt
      const win = await connect(S())
      try {
        const status = (await http(S(), 'GET', '/api/status')).body
        assert.deepEqual(status.daemons, { on: false, server: 'off', killed: false })
        const h = await harness(win, 'offturns')
        for (let i = 0; i < 8; i++) await turn(h, `off turn ${i}`)
        // A question still works as it always did.
        const qs = Date.now()
        ctl(h.project, { op: 'prompt', text: 'e2e:bash npm test' })
        const q = await question(win, h, qs)
        const answered = await answerLikeTheDial(win, h, q, 'Yes')
        assert.equal(answered.ok, true, JSON.stringify(answered))
        note('8 turns and a question answered')
        await sleep(70_000)                               // past a zoo.turn batch
        const reads = zooReads(since)
        note(`${reads.length} GET /api/zoo (${reads.map((r) => r.status).join(',')}), ${zooOps(since).length} POST /api/zoo/ops, ${zooChangedDown(since).length} zoo_changed`)
        assert.equal(reads.length, 1)
        assert.equal(reads[0].status, 404)
        assert.equal(zooOps(since).length, 0)
        assert.equal(zooChangedDown(since).length, 0)
        assert.equal(pushed(win).length, 0, 'no daemon_* frame')
        const act = await win.request('daemon_act', { id: 'need:x', choice: 'y' })
        const talk = await win.request('daemon_talk', { text: 'hi' })
        const confirm = await win.request('daemon_confirm', { kind: 'autonomy', nonce: 'x', accept: true })
        note(`daemon_act ${act.error}, daemon_talk ${talk.error}, daemon_confirm ${confirm.error}`)
        assert.equal(act.error, 'DAEMONS_OFF')
        assert.equal(talk.error, 'DAEMONS_OFF')
        assert.equal(confirm.error, 'DAEMONS_OFF')
        const tool = await connect(S(), { tool: true })
        const pair = await tool.request('pair', { verb: 'status' })
        await tool.close()
        assert.equal(pair.error, 'DAEMONS_OFF')
        const read = await http(S(), 'GET', '/api/zoo')
        assert.equal(read.status, 404, 'a window reads the server\'s 404 and hides everything')
      } finally { await win.close() }
    })

    scenario('D2', 'desktop: the zoo client draws nothing when the server says off', async (note) => {
      desktopNote(note, 'off')
    }, { skip: DESKTOP ? undefined : 'Set E2E_DESKTOP and E2E_FLUTTER.' })

    scenario('B2', 'local kill switch: HARNESS_DAEMONS=0 asks nothing, answers DAEMONS_OFF, even with the server on', async (note) => {
      sandbox('backend', '--daemons', 'on', '--backend', join(REPO, 'backend'))
      let since = Date.now()
      sandbox('harnessd', 'restart', '--cli', join(REPO, 'cli'), '--kill')
      refresh()
      since = S().harnessd.spawnAt   // the harnessd that stopped flushed its own last reports
      const win = await connect(S())
      try {
        await sleep(10_000)
        const status = (await http(S(), 'GET', '/api/status')).body
        note(`status.daemons ${JSON.stringify(status.daemons)}`)
        assert.equal(status.daemons.on, false)
        assert.ok(status.daemons.killed)
        assert.equal(zooReads(since).length, 0, 'nothing asked')
        const read = await http(S(), 'GET', '/api/zoo')
        assert.equal(read.status, 404)
        assert.equal(read.body?.error?.code, 'DAEMONS_OFF')
        assert.equal(zooReads(since).length, 0, 'answered without asking the backend')
        assert.equal(pushed(win).length, 0)
      } finally { await win.close() }
    })

    scenario('D3', 'desktop: the zoo client draws nothing under harnessd\'s kill switch', async (note) => {
      desktopNote(note, 'off')
    }, { skip: DESKTOP ? undefined : 'Set E2E_DESKTOP and E2E_FLUTTER.' })
  })

  describe('mixed versions', { concurrency: false }, () => {
    const noOld = !OLD_CLI || !OLD_BACKEND ? 'Set E2E_OLD_CLI and E2E_OLD_BACKEND (daemons/e2e/build-ref.sh).' : undefined

    async function existingFlows(win, name, note) {
      const desk = await http(S(), 'GET', '/api/desk')
      assert.equal(desk.status, 200, `desk read ${desk.status}`)
      const tab = `e2e${Date.now().toString(36)}`
      const opsR = await http(S(), 'POST', '/api/desk/ops', { ops: [{ op: 'tab.create', id: tab, name: 'E2E' }, { op: 'tab.close', id: tab }] })
      assert.equal(opsR.status, 200, `desk ops ${opsR.status} ${JSON.stringify(opsR.body).slice(0, 200)}`)
      const h = await harness(win, name)
      const list = await win.request('agents_list', {})
      assert.ok(list.agents.some((a) => a.id === h.agentId))
      await turn(h, 'an ordinary turn')
      const since = Date.now()
      ctl(h.project, { op: 'prompt', text: 'e2e:bash npm test' })
      const q = await question(win, h, since)
      const answered = await answerLikeTheDial(win, h, q, 'Yes')
      await until('approved', () => eventsOf(h.project, since).some((e) => e.kind === 'approved'), 10_000)
      note(`desk read+ops, agents_list, a turn, a question answered (${answered.ok ? 'ok' : answered.noReply ? 'typed; no question_response_result from this harnessd' : JSON.stringify(answered)})`)
      return h
    }

    scenario('C1', 'new harnessd + old backend (origin/main): the probe gets 404, daemons stay idle, the rest works', async (note) => {
      sandbox('backend', '--daemons', 'on', '--backend', OLD_BACKEND)
      let since = Date.now()
      sandbox('harnessd', 'restart', '--cli', join(REPO, 'cli'))
      refresh()
      since = S().harnessd.spawnAt   // the harnessd that stopped flushed its own last reports
      const win = await connect(S())
      try {
        await existingFlows(win, 'oldbackend', note)
        await sleep(65_000)
        const reads = zooReads(since)
        note(`${reads.length} GET /api/zoo (${reads.map((r) => r.status).join(',')}), ${zooOps(since).length} zoo ops`)
        assert.equal(reads.length, 1)
        assert.equal(reads[0].status, 404)
        assert.equal(zooOps(since).length, 0)
        assert.deepEqual((await http(S(), 'GET', '/api/status')).body.daemons, { on: false, server: 'off', killed: false })
        assert.equal(pushed(win).length, 0)
      } finally { await win.close() }
    }, { skip: noOld })

    scenario('C2', 'old harnessd (origin/main) + new backend: desk, agent list and question answers are unaffected', async (note) => {
      sandbox('backend', '--daemons', 'on', '--backend', join(REPO, 'backend'))
      let since = Date.now()
      sandbox('harnessd', 'restart', '--cli', OLD_CLI)
      refresh()
      since = S().harnessd.spawnAt   // the harnessd that stopped flushed its own last reports
      const win = await connect(S())
      try {
        await existingFlows(win, 'oldharnessd', note)
        await sleep(65_000)
        note(`${zooReads(since).length} GET /api/zoo, ${zooOps(since).length} zoo ops from the old harnessd`)
        assert.equal(zooReads(since).length, 0)
        assert.equal(zooOps(since).length, 0)
      } finally { await win.close() }
    }, { skip: noOld })

    scenario('C3', 'new client code + old harnessd: /api/zoo is 404 and daemon_* frames are refused, so daemons stay hidden', async (note) => {
      // The old harnessd from C2 is still running.
      assert.equal(S().harnessd.dir, OLD_CLI)
      const win = await connect(S())
      try {
        const read = await http(S(), 'GET', '/api/zoo')
        note(`GET /api/zoo → ${read.status}`)
        assert.equal(read.status, 404)
        win.send('daemon_shown', { id: 'need:x' })
        win.send('daemon_presence', { active: true })
        const act = await win.request('daemon_act', { id: 'need:x', choice: 'y' }, 10_000).catch((e) => ({ error: `no answer: ${e.message}` }))
        const talk = await win.request('daemon_talk', { text: 'hi' }, 10_000).catch((e) => ({ error: `no answer: ${e.message}` }))
        note(`daemon_act → ${act.error}, daemon_talk → ${talk.error}`)
        assert.equal(act.error, 'UNSUPPORTED')
        assert.equal(talk.error, 'UNSUPPORTED')
        // The connection still works for everything else.
        const list = await win.request('agents_list', {})
        assert.ok(Array.isArray(list.agents))
        assert.equal(pushed(win).length, 0)
      } finally { await win.close() }
    }, { skip: noOld })

    scenario('D4', 'desktop: the zoo client draws nothing against an old harnessd', async (note) => {
      desktopNote(note, 'off')
    }, { skip: noOld ?? (DESKTOP ? undefined : 'Set E2E_DESKTOP and E2E_FLUTTER.') })
  })
}
