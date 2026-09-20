// The room engine, tested where it is load-bearing: the seal, the shape of a turn, the claim map,
// and the one fact the app reads.
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const workspace = mkdtempSync(join(tmpdir(), 'roundtable-test-'))
process.env.HARNESS_WORKSPACE = workspace

const room = await import('../lib/room.mjs')
const { ADAPTERS, stripAnsi } = await import('../lib/engines.mjs')
const { buildPrompt, buildSystem } = await import('../lib/prompts.mjs')
const { renderHtml } = await import('../lib/render.mjs')
const { writeVerdict } = await import('../lib/verdict.mjs')

const SEATS = [
  { id: 'claude', engine: 'claude', stance: null },
  { id: 'codex', engine: 'codex', stance: 'the cheaper route is enough' },
]
const base = { spec: 1, motion: 'Native or WSL2?', status: 'running', evidence: [], wordCap: 220, seats: SEATS,
  rounds: room.PROTOCOL.map((r) => ({ id: r.id, name: r.name, state: 'pending' })) }

before(() => {
  writeFileSync(join(workspace, 'motion.md'), '# Native or WSL2?\n\nThe daemon is tmux-shaped.\n')
  room.writeRoom(base)
})

describe('turn files', () => {
  it('round-trips a turn through front matter', () => {
    room.writeTurn('opening', SEATS[1], { state: 'answered', body: '**Position.** Native.', elapsedMs: 1234 })
    const turn = room.readTurn('opening', 'codex')
    strictEqual(turn.front.engine, 'codex')
    strictEqual(turn.front.state, 'answered')
    strictEqual(turn.front.stance, 'the cheaper route is enough')
    strictEqual(turn.front.elapsed_ms, '1234')
    strictEqual(turn.body.trim(), '**Position.** Native.')
  })

  it('records an absent seat with its reason rather than dropping it', () => {
    room.writeTurn('opening', SEATS[0], { state: 'absent', body: '', elapsedMs: 900_000, error: 'no answer within 600s' })
    strictEqual(room.readTurn('opening', 'claude').front.state, 'absent')
    match(room.readTurn('opening', 'claude').front.error, /600s/)
  })
})

describe('what a seat is told', () => {
  const system = buildSystem(SEATS[0], base, 'opening')

  it('names the other vendors, the word cap and the shape', () => {
    match(system, /codex \(codex\)/)
    match(system, /At most 220 words/)
    match(system, /\*\*Position\.\*\*/)
    match(system, /read-only/)
  })

  it('seals the openings: no peer turns reach the first round', () => {
    const prompt = buildPrompt(SEATS[0], base, { ...room.PROTOCOL[0], peers: false }, { motionText: 'Native or WSL2?', peerTurns: [] })
    ok(!prompt.includes('What the other seats said'))
  })

  it('hands over the peers from cross-examination on', () => {
    const prompt = buildPrompt(SEATS[0], base, room.PROTOCOL[1], {
      motionText: 'Native or WSL2?',
      peerTurns: [{ seatId: 'codex', roundName: 'Openings', front: { engine: 'codex' }, body: '**Position.** WSL2.' }],
    })
    match(prompt, /What the other seats said/)
    match(prompt, /codex \(codex\)/)
  })
})

describe('engine adapters', () => {
  it('builds a read-only argv per vendor', () => {
    const claude = ADAPTERS.claude.build({ system: 'S', prompt: 'P', model: null })
    ok(claude.args.includes('--allowedTools') && !claude.args.includes('Write'))
    strictEqual(claude.capture, 'stdout')
    const codex = ADAPTERS.codex.build({ system: 'S', prompt: 'P', model: null, outFile: '/tmp/a.md' })
    ok(codex.args.includes('read-only'))
    strictEqual(codex.capture, 'file')
  })

  it('strips the decoration and keeps the answer', () => {
    strictEqual(stripAnsi('\u001b[0mOK\u001b[32m'), 'OK')
    strictEqual(ADAPTERS.opencode.clean('> build · some-model\n\n**Position.** Native.'), '**Position.** Native.')
  })
})

describe('the verdict', () => {
  it('is not ready while the room is still talking', () => {
    const verdict = writeVerdict()
    strictEqual(verdict.ready, false)
    strictEqual(verdict.artifact, 'index.html')
    ok(verdict.findings.some((f) => f.kind === 'seat_unavailable' && f.severity === 'error'))
    deepStrictEqual(verdict.phases.map((p) => p.name), ['Openings', 'Cross-examination', 'Convergence', 'Decision'])
  })

  it('turns a split claim into a warning and an agreed one into info', () => {
    writeFileSync(join(workspace, 'claims.json'), JSON.stringify({ claims: [
      { id: 'tmux', text: 'The daemon is tmux-shaped', by: { claude: 'agree', codex: 'disagree' } },
      { id: 'cost', text: 'A native port is a quarter', by: { claude: 'agree', codex: 'agree' } },
    ] }))
    const verdict = writeVerdict()
    ok(verdict.findings.some((f) => f.kind === 'split' && f.severity === 'warning' && /tmux-shaped/.test(f.message)))
    ok(verdict.findings.some((f) => f.kind === 'agreed' && f.severity === 'info'))
  })

  it('stays unready when a decision is written but a seat never spoke', () => {
    writeFileSync(join(workspace, 'decision.md'), '# The call\n\nWSL2 first.\n')
    room.writeRoom({ ...base, status: 'decided' })
    strictEqual(writeVerdict().ready, false)
  })

  it('is ready only when every seat answered every round and the call is written', () => {
    for (const round of room.PROTOCOL) {
      for (const seat of SEATS) room.writeTurn(round.id, seat, { state: 'answered', body: '**Position.** Yes.', elapsedMs: 10 })
    }
    const verdict = writeVerdict()
    strictEqual(verdict.ready, true)
    match(verdict.summary, /^Decided/)
  })
})

describe('the pane', () => {
  it('draws a column per seat, a row per round, and the claim map', () => {
    const html = renderHtml()
    match(html, /grid-template-columns:160px repeat\(2/)
    for (const name of ['Openings', 'Cross-examination', 'Convergence']) match(html, new RegExp(name))
    match(html, /The daemon is tmux-shaped/)
    match(html, /class="m no"/)   // the split
    match(html, /class="m yes"/)  // the agreement
    match(html, /The call/)
  })

  it('shows an empty room rather than a broken one', () => {
    room.writeRoom({ ...base, seats: [], status: 'seating' })
    match(renderHtml(), /No seats yet/)
    room.writeRoom(base)
  })

  it('never lets a turn inject markup into the pane', () => {
    room.writeTurn('opening', SEATS[0], { state: 'answered', body: '<img src=x onerror=alert(1)>', elapsedMs: 5 })
    ok(!renderHtml().includes('<img src=x'))
    match(renderHtml(), /&lt;img src=x/)
  })
})

after(() => { /* tmpdir is the OS's to clean */ })

describe('a turn starts at its position', () => {
  it('drops the research narration some CLIs print before the answer', async () => {
    const { trimToShape } = await import('../lib/prompts.mjs')
    strictEqual(trimToShape("I'll inspect the daemon first.**Position.** WSL2.", 'opening'), '**Position.** WSL2.')
    strictEqual(trimToShape('**Position.** Native.', 'opening'), '**Position.** Native.')
    strictEqual(trimToShape('no shape at all', 'opening'), 'no shape at all')
  })
})

describe('a seat is a fresh process every round', () => {
  it('is handed its own earlier turn back, marked as its own', () => {
    const prompt = buildPrompt(SEATS[0], base, room.PROTOCOL[1], {
      motionText: 'Native or WSL2?',
      ownTurns: [{ roundName: 'Openings', body: '**Position.** Native.' }],
      peerTurns: [{ seatId: 'codex', roundName: 'Openings', front: { engine: 'codex' }, body: '**Position.** WSL2.' }],
    })
    match(prompt, /What you said earlier/)
    match(prompt, /This is your position/)
    match(prompt, /codex \(codex\) — Openings/)
    ok(prompt.indexOf('What you said earlier') < prompt.indexOf('What the other seats said'))
  })
})

describe('a seat that overruns', () => {
  it('is killed as a process group, so a shelling-out CLI cannot outlive its round', async () => {
    const { runRound } = await import('../lib/run.mjs')
    const slow = { ...base, seats: [{ id: 'slow', engine: 'claude', stance: null }] }
    const { ADAPTERS } = await import('../lib/engines.mjs')
    const real = ADAPTERS.claude.build
    // A "CLI" that shells out to something long-lived and then waits on it.
    ADAPTERS.claude.build = () => ({ args: ['-c', 'sleep 120 & sleep 120'], capture: 'stdout' })
    ADAPTERS.claude.bin = 'sh'
    const started = Date.now()
    const [result] = await runRound(slow, { ...room.PROTOCOL[0], previousId: null }, { motionText: 'x', timeoutMs: 1500 })
    ADAPTERS.claude.build = real; ADAPTERS.claude.bin = 'claude'
    strictEqual(result.state, 'absent')
    ok(Date.now() - started < 20_000, 'the round ended with the timeout, not with the grandchild')
    match(room.readTurn('opening', 'slow').front.error, /within 2s/)
  })
})
