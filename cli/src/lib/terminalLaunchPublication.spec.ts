import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { buildEngineLaunchArgv } from './engineLaunch.js'
import { createAndRegisterPane } from './createAgentPane.js'
import { PtyHostBackend } from './ptyHostBackend.js'
import type { PtyHostClient } from './ptyHost/client.js'
import type { RegisteredSession } from './registry.js'

const folder = join(env.ADAPTER_DATA_DIR, 'launch')
const files = () => existsSync(folder) ? readdirSync(folder).filter(name => name.endsWith('.sh')) : []

it.each(['dispatch', 'receipt refusal', 'required changed', 'registration retry'] as const)(
  'publishes only executable one-time scripts on %s', async scenario => {
    rmSync(folder, { recursive: true, force: true })
    let current = true, attempts = 0, release!: () => void, entered!: () => void
    const receipt = new Promise<void>(resolve => { release = resolve })
    const preparing = new Promise<void>(resolve => { entered = resolve })
    const executed: string[] = []
    const client = { instance: 'publication-fixture', features: [], onEvent: () => () => {}, onClose: () => () => {}, close() {},
      openStream: async () => null,
      call: async (op: { op: string; command?: string[] }) => {
        if (op.op !== 'create') return { state: 'ok', value: {} }
        const source = op.command?.find(word => word.startsWith(". '") && word.endsWith(".sh'"))
        expect(source).toBeDefined()
        const file = source!.slice(3, -1)
        expect(file.startsWith(folder)).toBe(true)
        expect(op.command).toContain('fixture-command')
        expect(readFileSync(file, 'utf8')).toContain('harness_engine_bin=$1')
        executed.push(file)
        return { state: 'ok', value: { pane: `%${++attempts}` } }
      } } as unknown as PtyHostClient
    const backend = new PtyHostBackend({ home: env.ADAPTER_DATA_DIR, launch: async () => ({ client }), owner: () => 'fixture', platform: 'linux' })
    const command = vi.fn(() => buildEngineLaunchArgv('claude', { extraArgs: ['fixture-command'] }, '/bin/sh', process.execPath, '/fixture/grid', null))
    try {
      expect(await backend.prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
      const pending = createAndRegisterPane({ engine: 'claude', sessionLabel: 'fixture', argv: command as never,
        current: () => current, onDispatch: async () => { entered(); await receipt; if (scenario === 'receipt refusal') throw Error('fixture receipt refusal') },
        tmuxBackend: { create: request => backend.create(request), kill: runtime => backend.kill(runtime) },
        registry: { openPendingAgent: async () => scenario === 'registration retry' && attempts === 1 ? null : { agentId: 'fixture' } as RegisteredSession },
      })
      await preparing
      expect(files()).toEqual([]); expect(command).not.toHaveBeenCalled()
      if (scenario === 'required changed') current = false
      release()
      const result = await pending
      const count = scenario === 'registration retry' ? 2 : scenario === 'dispatch' ? 1 : 0
      expect(result.ok).toBe(count > 0)
      expect(command).toHaveBeenCalledTimes(count)
      expect(executed).toHaveLength(count)
      expect(files().map(name => join(folder, name)).sort()).toEqual([...executed].sort())
      expect(new Set(executed).size).toBe(count)
    } finally { release(); backend.dispose(); rmSync(folder, { recursive: true, force: true }) }
  },
)
