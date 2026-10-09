/** Former-code record of external-owner control effects, before moving them into a core-only leaf. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'

process.env.TZ = 'UTC'
const fixture = fileURLToPath(new URL('./__fixtures__/external-owner-control.golden.json', import.meta.url))

it('preserves ordered terminal-owner signals, bounded waits and terminal restoration on both platforms', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const out: Record<string, unknown> = {}
  try {
    for (const os of ['darwin', 'linux']) {
      Object.defineProperty(process, 'platform', { value: os })
      vi.resetModules()
      const { stopSessionOwner } = await import('./externalOwnerControl.js')
      for (const mode of ['term', 'kill', 'stuck', 'gone', 'group', 'job-failed', 'signal-failed', 'tty-failed', 'no-tty']) {
        const effects: unknown[] = []
        let alive = mode !== 'gone', signals = 0, waited = 0
        const ok = await stopSessionOwner({ pid: 7, tty: mode === 'no-tty' ? null : '/dev/fixture-terminal' }, {
          alive: () => alive,
          kill: (pid, signal) => {
            effects.push(['signal', pid, signal]); signals++
            if (mode === 'signal-failed') { alive = false; throw new Error('gone') }
            if (mode !== 'stuck' && (mode !== 'kill' || signals === 2)) alive = false
          },
          sleep: async ms => { waited += ms },
          job: async pid => { effects.push(['foreground', pid]); if (mode === 'job-failed') throw new Error('ps unavailable'); return mode === 'group' ? pid : null },
          writeTty: async (tty, value) => { effects.push(['tty', tty, value]); if (mode === 'tty-failed') throw new Error('closed') },
        })
        out[`${os}/${mode}`] = { ok, effects, waited }
      }
    }
    if (process.env.RECORD_EXTERNAL_CONTROL === '1') { mkdirSync(dirname(fixture), { recursive: true }); writeFileSync(fixture, JSON.stringify(out, null, 2) + '\n') }
    expect(out).toEqual(JSON.parse(readFileSync(fixture, 'utf8')))
  } finally { Object.defineProperty(process, 'platform', platform); vi.resetModules() }
})
