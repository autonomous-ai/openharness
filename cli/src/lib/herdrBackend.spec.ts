import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HERDR_PANE_RE, HerdrBackend, OwnedHerdrPanes, herdrError, herdrPane, type HerdrRun } from './herdrBackend.js'

const snapshot = JSON.stringify({
  result: {
    snapshot: {
      panes: [
        { pane_id: 'w6D:p1', cwd: '/work/live' },
        { pane_id: '*', cwd: '/nope' },
      ],
    },
  },
})

function fake(calls: string[]): HerdrRun {
  return async (args) => {
    calls.push(args.join(' '))
    const line = args.join(' ')
    if (line === 'api snapshot') return { code: 0, stdout: snapshot, stderr: '' }
    if (line === 'pane process-info --pane w6D:p1') {
      return { code: 0, stdout: JSON.stringify({ result: { process_info: { shell_pid: 42, foreground_processes: [{ pid: 99, name: 'omp' }] } } }), stderr: '' }
    }
    if (line.startsWith('workspace create')) {
      return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: 'w9:p1' } } }), stderr: '' }
    }
    if (line.startsWith('pane read')) return { code: 0, stdout: 'visible text', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
}

describe('HerdrBackend', () => {
  it('inventories local panes and refuses a broad target', async () => {
    const calls: string[] = []
    const backend = new HerdrBackend(fake(calls))
    const listed = await backend.inventory()
    expect(listed).toEqual({
      state: 'available',
      roots: [{ runtime: { backend: 'herdr', paneId: 'w6D:p1' }, rootPid: 42, cwd: '/work/live' }],
    })
    expect(calls.some((line) => line.includes('--remote') || line.startsWith('server'))).toBe(false)
    expect(await backend.kill({ backend: 'herdr', paneId: 'w6D:p1' })).toMatchObject({
      state: 'failed', reason: expect.stringContaining('did not create'),
    })
    expect(calls.some((line) => line.startsWith('pane close'))).toBe(false)
    expect(calls.some((line) => line.startsWith('pane close'))).toBe(false)
  })

  it('opens a stream by reading the pane, never by attaching', async () => {
    const calls: string[] = []
    const backend = new HerdrBackend(fake(calls))
    const opened = await backend.openStream(
      { backend: 'herdr', paneId: 'w6D:p1' },
      { engine: 'omp' },
      { cols: 80, rows: 24 },
      { onData: () => {}, onClose: () => {} },
    )
    expect(opened.state).toBe('succeeded')
    if (opened.state !== 'succeeded') return
    expect((await opened.value.snapshot()).state).toBe('succeeded')
    await opened.value.close()
    expect(calls.some(line => line.includes('attach') || line.includes('--remote'))).toBe(false)
    expect(calls.some(line => line.startsWith('pane read'))).toBe(true)
  })

  it('creates with --no-focus and will close only that pane', async () => {
    const calls: string[] = []
    const owned = new OwnedHerdrPanes(join(mkdtempSync(join(tmpdir(), 'herdr-owned-')), 'owned.json'))
    const backend = new HerdrBackend(fake(calls), owned)
    const created = await backend.create({ cwd: '/work/new', label: 'harness-omp' })
    expect(created).toMatchObject({ state: 'succeeded', runtime: { backend: 'herdr', paneId: 'w9:p1' } })
    expect(calls[0]).toBe('workspace create --no-focus --cwd /work/new --label harness-omp')
    expect(await backend.kill({ backend: 'herdr', paneId: 'w9:p1' })).toMatchObject({ state: 'succeeded' })
    expect(calls.at(-1)).toBe('pane close w9:p1')
  })

  it('sends text without attach or focus', async () => {
    const calls: string[] = []
    const backend = new HerdrBackend(fake(calls))
    expect(await backend.submitText({ backend: 'herdr', paneId: 'w6D:p1' }, 'hello')).toMatchObject({ state: 'succeeded' })
    expect(calls).toEqual([
      'pane send-text w6D:p1 hello',
      'pane send-keys w6D:p1 enter',
    ])
  })

  it('accepts alphanumeric pane ids (wN:p6DB) and refuses anything else', () => {
    for (const id of ['w6D:p1', 'w12:p6DB', 'wH:pA1']) expect(HERDR_PANE_RE.test(id)).toBe(true)
    for (const id of ['w6D:p', 'w6D', '6D:p1', 'w6D:p1;rm', 'w6D:p-1', '--remote']) expect(HERDR_PANE_RE.test(id)).toBe(false)
    expect(herdrPane('w12:p6DB')).toEqual({ backend: 'herdr', paneId: 'w12:p6DB' })
  })

  it('titles every pane from one snapshot, with omp spinner, status and icon stripped', async () => {
    const frames = ['π ⠴ \u{F08F3} Login: Fix the redirect loop', 'π ⠙ \u{F08F3} Login: Fix the redirect loop', 'π > \u{F08F3} Login: Fix the redirect loop']
    for (const frame of frames) {
      const calls: string[] = []
      const run: HerdrRun = async (args) => {
        calls.push(args.join(' '))
        return { code: 0, stderr: '', stdout: JSON.stringify({ result: { snapshot: { panes: [
          { pane_id: 'w6D:p1', terminal_title_stripped: frame },
          { pane_id: 'wN:p6DB', terminal_title_stripped: 'π ⠏ Review MLX PRs 81 82' },
          { pane_id: 'w72:p1', terminal_title_stripped: '' },
          { pane_id: '*', terminal_title_stripped: 'π > nope' },
        ] } } }) }
      }
      const titles = await new HerdrBackend(run).titles()
      expect(calls).toEqual(['api snapshot'])
      expect(titles.state).toBe('succeeded')
      if (titles.state !== 'succeeded') return
      expect([...titles.value]).toEqual([
        ['herdr\u0000w6D:p1', 'Login: Fix the redirect loop'],
        ['herdr\u0000wN:p6DB', 'Review MLX PRs 81 82'],
      ])
    }
  })

  it('reports a failed title snapshot instead of an empty one', async () => {
    const titles = await new HerdrBackend(async () => ({ code: 1, stdout: '', stderr: 'no server' })).titles()
    expect(titles).toEqual({ state: 'failed', reason: 'no server' })
  })

  it('counts a pane whose process-info fails or times out as a failed restore check, but still present', async () => {
    const run: HerdrRun = async (args) => {
      const line = args.join(' ')
      if (line === 'api snapshot') return { code: 0, stderr: '', stdout: JSON.stringify({ result: { snapshot: { panes: [{ pane_id: 'w1:p1' }, { pane_id: 'w2:p1' }] } } }) }
      if (line === 'pane process-info --pane w1:p1') return { code: 0, stderr: '', stdout: JSON.stringify({ result: { process_info: { shell_pid: 7 } } }) }
      return { code: 1, stdout: '', stderr: 'timed out' }
    }
    const survey = await new HerdrBackend(run).restoreSurvey()
    expect([...(survey.livePaneIds ?? [])]).toEqual(['w1:p1', 'w2:p1'])
    expect(survey.failedChecks).toBe(1)
    expect(await new HerdrBackend(async () => ({ code: 1, stdout: '', stderr: 'down' })).restoreSurvey()).toEqual({ livePaneIds: null, failedChecks: 1 })
  })

  it('says once, in herdr\'s words, why it cannot see any pane, and says so again when that changes or clears', async () => {
    const answers = [
      { code: 1, stdout: '', stderr: '{"id":"cli:api:snapshot","error":{"code":"protocol_mismatch","message":"client protocol 20 is older than server protocol 22; upgrade the Herdr client before using this command"}}' },
      { code: 1, stdout: '', stderr: '{"id":"cli:api:snapshot","error":{"code":"protocol_mismatch","message":"client protocol 20 is older than server protocol 22; upgrade the Herdr client before using this command"}}' },
      { code: 1, stdout: '', stderr: '{"id":"cli:api:snapshot","error":{"code":"server_not_running","message":"no herdr server is running at /run/herdr.sock; run `herdr` to start or attach it"}}' },
      { code: 0, stderr: '', stdout: JSON.stringify({ result: { snapshot: { panes: [] } } }) },
      { code: 0, stderr: '', stdout: JSON.stringify({ result: { snapshot: { panes: [] } } }) },
    ]
    const logs: string[] = []
    const backend = new HerdrBackend(async () => answers.shift()!, undefined, (line) => logs.push(line))
    expect(await backend.inventory()).toEqual({ state: 'unavailable',
      reason: 'client protocol 20 is older than server protocol 22; upgrade the Herdr client before using this command · set HERDR_BIN to the herdr that matches the running server' })
    expect(await backend.titles()).toMatchObject({ state: 'failed' })
    expect(await backend.restoreSurvey()).toEqual({ livePaneIds: null, failedChecks: 1 })
    expect(await backend.inventory()).toEqual({ state: 'available', roots: [] })
    expect(await backend.inventory()).toEqual({ state: 'available', roots: [] })
    expect(logs).toEqual([
      '[herdr] unavailable · client protocol 20 is older than server protocol 22; upgrade the Herdr client before using this command · set HERDR_BIN to the herdr that matches the running server',
      '[herdr] unavailable · no herdr server is running at /run/herdr.sock; run `herdr` to start or attach it',
      '[herdr] available again',
    ])
  })

  it('reads herdr\'s pane_not_found as gone, and any other failure as unknown', async () => {
    const missing = new HerdrBackend(async () => ({ code: 1, stdout: '', stderr: '{"error":{"code":"pane_not_found","message":"pane not found"},"id":"cli:pane:process_info"}' }))
    expect(await missing.validate({ backend: 'herdr', paneId: 'wN:p6DB' }, { engine: 'omp' })).toEqual({ state: 'gone', reason: 'herdr has no pane wN:p6DB' })
    const down = new HerdrBackend(async () => ({ code: 1, stdout: '', stderr: 'connection refused' }))
    expect(await down.validate({ backend: 'herdr', paneId: 'wN:p6DB' }, { engine: 'omp' })).toEqual({ state: 'unknown', reason: 'connection refused' })
    expect(herdrError({ code: 1, stdout: 'noise\n{"error":{"code":"timeout"}}', stderr: '' })).toEqual({ code: 'timeout', message: 'timeout' })
    expect(herdrError({ code: 1, stdout: '', stderr: 'plain text' })).toEqual({ code: null, message: 'plain text' })
  })
})
