/** Pin the stop path core actually calls, including its refusal to signal on missing evidence. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { stopExternalOwner } from './externalOwner.js'

const fixture = fileURLToPath(new URL('./__fixtures__/external-owner.golden.json', import.meta.url))

it('preserves ordered owner checks, signals and bounded waits on the production stop path', async () => {
  const out: Record<string, unknown> = {}
  for (const mode of ['term', 'kill', 'stuck', 'gone', 'group', 'job-failed', 'signal-failed', 'no-tty', 'changed']) {
    const effects: unknown[] = []
    let alive = mode !== 'gone', signals = 0, waited = 0
    const owner = { process: { pid: 7, engine: 'claude' as const, tty: mode === 'no-tty' ? null : '/dev/fixture-terminal',
      record: '/fixture/record' }, generation: 'ps:1' }
    const ok = await stopExternalOwner(owner, {
      current: () => true,
      same: async () => { effects.push(['same']); return mode !== 'changed' },
      generation: () => 'ps:1',
      exists: () => alive,
      kill: (pid, signal) => {
        effects.push(['signal', pid, signal]); signals++
        if (mode === 'signal-failed') { alive = false; throw new Error('gone') }
        if (mode !== 'stuck' && (mode !== 'kill' || signals === 2)) alive = false
      },
      sleep: async ms => { waited += ms },
      job: async pid => {
        effects.push(['foreground', pid])
        if (mode === 'job-failed') throw new Error('ps unavailable')
        return mode === 'group' ? pid : null
      },
      beforeSignal: signal => { effects.push(['intent', signal]) },
      afterSignal: signal => { effects.push(['sent', signal]) },
    })
    out[mode] = { ok, effects, waited }
  }
  if (process.env.RECORD_EXTERNAL_CONTROL === '1') { mkdirSync(dirname(fixture), { recursive: true }); writeFileSync(fixture, JSON.stringify(out, null, 2) + '\n') }
  expect(out).toEqual(JSON.parse(readFileSync(fixture, 'utf8')))
})
