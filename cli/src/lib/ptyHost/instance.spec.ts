import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoveryFileName, hostInstanceName, instanceProtocol, PTY_HOST_INSTANCE, PTY_HOST_PANE } from './instance.js'

describe('hostInstanceName', () => {
  it('names follow the host\'s shared vectors', () => {
    // The host's own test reads the same file (pty/src/instance.rs): both sides name one build alike.
    const file = path.join(import.meta.dirname, '..', '..', '..', '..', 'pty', 'tests', 'fixtures', 'instances.json')
    const vectors = JSON.parse(readFileSync(file, 'utf8')) as Array<{ protocol: number; version: string; instance: string }>
    expect(vectors.length).toBeGreaterThanOrEqual(6)
    for (const vector of vectors) {
      expect(hostInstanceName(vector.protocol, vector.version), JSON.stringify(vector)).toBe(vector.instance)
      expect(PTY_HOST_INSTANCE.test(vector.instance)).toBe(true)
    }
  })
})

describe('PTY_HOST_INSTANCE', () => {
  it('takes a legacy p<protocol>, a version tag and a hash tag, and nothing else', () => {
    for (const good of ['p1', 'p2', 'p2-0.4.21-dev.win1', 'p2-h0123456789ab', 'p9999-1']) expect(PTY_HOST_INSTANCE.test(good), good).toBe(true)
    for (const bad of ['', 'p', 'P2', 'p12345', 'p2-', 'p2-a/b', 'p2-a b', 'p2-0.4.21+meta', `p2-${'1'.repeat(33)}`, 'p2:%1', '../p2']) {
      expect(PTY_HOST_INSTANCE.test(bad), bad).toBe(false)
    }
  })

  it('makes the HARNESS_PANE pattern: <instance>:%N', () => {
    expect(PTY_HOST_PANE.exec('p2-0.4.21-dev.win1:%7')?.slice(1)).toEqual(['p2-0.4.21-dev.win1', '%7'])
    expect(PTY_HOST_PANE.exec('p2-h0123456789ab:%7')?.slice(1)).toEqual(['p2-h0123456789ab', '%7'])
    expect(PTY_HOST_PANE.exec('p1:%3')?.slice(1)).toEqual(['p1', '%3'])
    for (const bad of ['%7', 'p2-0.4.21:7', 'p2-0.4.21:%7; calc', 'p2-0.4.21:%1234567890']) expect(PTY_HOST_PANE.test(bad), bad).toBe(false)
  })
})

describe('instance files', () => {
  it('a legacy instance keeps its protocol-named file; a versioned one is named by its instance', () => {
    expect(discoveryFileName('p2')).toBe('pty-host-2.json')
    expect(discoveryFileName('p2-0.4.20')).toBe('pty-host-p2-0.4.20.json')
    expect(discoveryFileName('p2/../x')).toBeNull()
    expect(instanceProtocol('p2-0.4.20')).toBe(2)
    expect(instanceProtocol('p13')).toBe(13)
    expect(instanceProtocol('q2')).toBeNull()
  })
})
