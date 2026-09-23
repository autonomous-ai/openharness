import { describe, expect, it } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { DeviceStoreRequestSchema, DeviceStoreResultSchema } from './storeContract.js'
import { AutonomousDeviceStore } from './store.js'
import { AutonomousDeviceService } from './service.js'
const directory = new URL('../../../../docs/contracts/autonomous-device-store-v1/', import.meta.url)
describe('OS handoff contract', () => {
  it('keeps published JSON schemas identical to runtime validators', () => {
    for (const [name, schema] of [['request', DeviceStoreRequestSchema], ['response', DeviceStoreResultSchema]] as const) {
      if (name === 'request') {
        const json = z.toJSONSchema(schema, { io: 'input' }) as { oneOf: Array<{ required: string[] }> }
        expect(json.oneOf[0].required).toEqual(['type', 'requestId'])
      }
      expect(JSON.parse(readFileSync(new URL(`${name}.schema.json`, directory), 'utf8'))).toEqual(z.toJSONSchema(schema, { io: name === 'request' ? 'input' : 'output' }))
    }
  })
  it('validates fixtures and replays the Blender request sequence through the actual service', async () => {
    const fixture = JSON.parse(readFileSync(new URL('blender.fixture.json', directory), 'utf8'))
    const path = mkdtempSync(join(tmpdir(), 'device-contract-'))
    let installed = false, created = false
    const store = new AutonomousDeviceStore({ directory: path, machineId: 'mac-example',
      packages: async () => [{ packageId: 'autonomous/blender', name: 'Blender', description: '3D', category: '3D', engine: 'claude', installed,
        catalog: true, verified: true, viewerPackageId: null, installAllowed: true, version: null, broken: null }],
      install: async () => { installed = true; return { ok: true } }, doctor: async () => ({ ok: true, checked: true, lines: [] }),
      workspace: async () => '/Users/example/harnesses/airplane', create: async () => { created = true; return { state: 'created', agentId: 'agent-example' } },
      agents: () => created ? [{ agentId: 'agent-example', machineId: 'mac-example', packageId: 'autonomous/blender', workspace: '/Users/example/harnesses/airplane', engine: 'claude', state: 'idle', runtime: 'ready' }] : [],
    })
    let sent = 0
    const service = new AutonomousDeviceService({ machineId: 'mac-example', store,
      agents: () => created ? [{ agentId: 'agent-example', name: 'Airplane', engine: 'claude', state: 'idle' }] : [],
      submit: () => { sent++ }, cancelDelivery: () => true, stop: async () => true, answer: async () => true, recent: () => [] })
    try {
      for (const step of fixture.steps) {
        DeviceStoreRequestSchema.parse(step.request)
        if (step.response) DeviceStoreResultSchema.parse(step.response)
        if (step.request.type === 'operation.get') {
          await expect.poll(() => store.get(fixture.deviceIdentity, step.request.operationId).state).toBe('ready')
        }
        const actual = await service.request(fixture.deviceIdentity, step.request)
        DeviceStoreResultSchema.parse(actual)
        if (step.response?.operation) expect(actual).toMatchObject({ operation: { operationId: step.response.operation.operationId, state: step.response.operation.state, taskDispatched: false } })
      }
      // Invalid correlation fields are echoed when present, absent when missing.
      DeviceStoreResultSchema.parse(await service.request(fixture.deviceIdentity, { type: 'store.list' }))
      DeviceStoreResultSchema.parse(await service.request(fixture.deviceIdentity, { type: 'store.list', requestId: 'invalid' }))
      expect(sent).toBe(0)
      await service.request(fixture.deviceIdentity, fixture.taskRequest)
      await service.request(fixture.deviceIdentity, fixture.taskRequest)
      expect(sent).toBe(1)
    } finally { rmSync(path, { recursive: true, force: true }) }
  })
})
