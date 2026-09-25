import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceDump, resolveDumpPath } from './dump.js'

describe('device dump', () => {
  it('is off unless configured, and never creates a file then', () => {
    for (const value of [undefined, '', '0', 'false']) expect(resolveDumpPath(value, '/logs')).toBeNull()
    const dump = new DeviceDump(() => undefined)
    dump.record('in', 'rpc', 'conn', { type: 'x' })
    expect(dump.enabled).toBe(false)
  })

  it('defaults to a timestamped file in the logs dir', () => {
    expect(resolveDumpPath('1', '/logs')).toMatch(/^\/logs\/device-dump-\d{8}-\d{6}\.jsonl$/)
    expect(resolveDumpPath('/tmp/x.jsonl', '/logs')).toBe('/tmp/x.jsonl')
  })

  it('writes one private JSON line per frame, labelled with direction, transport and layer', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dump-')), 'nested', 'd.jsonl')
    const dump = new DeviceDump(() => file)
    dump.record('in', 'rpc', 'autonomous-direct:abc', { type: 'autonomous_device_request', payload: { type: 'hello' } })
    dump.record('out', 'commander', undefined, { type: 'commander_event', payload: { kind: 'done' } })
    dump.record('out', 'wire', 'relay-conn', { type: 'e2e_welcome', payload: { key: new Uint8Array([1, 2]) } })
    dump.close()
    expect(existsSync(file)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines.map(l => [l.dir, l.via, l.layer, l.type])).toEqual([
      ['in', 'direct', 'rpc', 'autonomous_device_request'],
      ['out', 'broadcast', 'commander', 'commander_event'],
      ['out', 'relay', 'wire', 'e2e_welcome'],
    ])
    expect(lines[0].frame.payload).toEqual({ type: 'hello' })
    expect(lines[2].frame.payload.key).toEqual({ base64: 'AQI=' })
  })
})
