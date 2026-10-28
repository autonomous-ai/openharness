import { describe, expect, it } from 'vitest'
import { readinessRows, runMachinesEngines, type MachineProbe } from './machineEngines.js'

const OFFICE = 'm-office-1'

describe('readinessRows (#1788)', () => {
  it('reads a probe that said false as unknown, never as not there', () => {
    const rows = readinessRows(OFFICE, {
      engines: [
        { engine: 'claude', installed: true, installable: true, signedIn: false, firstPrompt: true },
        { engine: 'hermes', installed: false, installable: true, firstPrompt: true },
      ],
    })
    expect(rows).toEqual([
      { machineId: OFFICE, engine: 'claude', installed: true, signedIn: false, installable: true, firstPrompt: true },
      { machineId: OFFICE, engine: 'hermes', installed: null, signedIn: null, installable: true, firstPrompt: true },
    ])
  })

  it('says signedIn only once installed, and firstPrompt is unknown from an older Harness', () => {
    const rows = readinessRows(OFFICE, {
      engines: [
        { engine: 'codex', installed: false, signedIn: false },
        { engine: 'cursor', installed: true },
        'not an entry',
        { installed: true },
      ],
    })
    expect(rows).toEqual([
      { machineId: OFFICE, engine: 'codex', installed: null, signedIn: null, installable: null, firstPrompt: null },
      { machineId: OFFICE, engine: 'cursor', installed: true, signedIn: null, installable: null, firstPrompt: null },
    ])
  })
})

describe('harness machines engines (#1788)', () => {
  const probing = (reply: Record<string, unknown>) => {
    const asked: Array<{ machine: string; payload: Record<string, unknown> }> = []
    const probe: MachineProbe = async (machine, payload) => {
      asked.push({ machine, payload })
      return { machineId: OFFICE, reply }
    }
    return { asked, probe }
  }

  it('asks the named machine for the engines named, and prints one JSON line each', async () => {
    const { asked, probe } = probing({ engines: [{ engine: 'hermes', installed: true, installable: true, firstPrompt: true }] })
    const lines: string[] = []
    const code = await runMachinesEngines(['office', '--engine', 'hermes', '--engine', 'hermes', '--json'], '/tmp', 1, probe, (line) => lines.push(line))
    expect(code).toBe(0)
    expect(asked).toEqual([{ machine: 'office', payload: { engines: ['hermes'] } }])
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { machineId: OFFICE, engine: 'hermes', installed: true, signedIn: null, installable: true, firstPrompt: true },
    ])
  })

  it('asks for every engine when none is named', async () => {
    const { asked, probe } = probing({ engines: [] })
    expect(await runMachinesEngines(['office', '--json'], '/tmp', 1, probe, () => {})).toBe(0)
    expect(asked[0].payload).toEqual({})
  })

  it('refuses an engine it does not know, a missing machine and an unknown flag, asking nothing', async () => {
    const { asked, probe } = probing({ engines: [] })
    for (const argv of [['office', '--engine', 'nope'], [], ['office', '--engine'], ['office', '--fast'], ['a', 'b']]) {
      expect(await runMachinesEngines(argv, '/tmp', 1, probe, () => {})).toBe(2)
    }
    expect(asked).toEqual([])
  })

  it('fails plainly when the machine cannot be reached or its probe fails', async () => {
    const unreachable: MachineProbe = async () => { throw new Error('Link this computer in Machines first.') }
    expect(await runMachinesEngines(['office', '--json'], '/tmp', 1, unreachable, () => {})).toBe(1)
    const { probe } = probing({ error: 'ENGINE_PROBE_FAILED' })
    const lines: string[] = []
    expect(await runMachinesEngines(['office', '--json'], '/tmp', 1, probe, (line) => lines.push(line))).toBe(1)
    expect(lines).toEqual([])
  })
})
