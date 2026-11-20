import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CheckpointStages, type CheckpointStage } from './checkpointStages.js'

const fault = vi.hoisted(() => ({ kind: '', root: '', paths: new Map<number, string>(), replace: '', statFailed: new Set<number>() }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      if (fault.kind === 'owner-open' && String(args[0]).endsWith('owner.json')) throw new Error('injected owner-open')
      const fd = fs.openSync(...args); fault.paths.set(fd, String(args[0])); return fd
    },
    closeSync: (fd: number) => { try { fs.closeSync(fd) } finally { fault.paths.delete(fd); fault.statFailed.delete(fd) } },
    fstatSync: (...args: Parameters<typeof fs.fstatSync>) => {
      if (fault.paths.get(args[0])?.endsWith('owner.json') && (fault.kind === 'owner-stat-persistent'
        || (fault.kind === 'owner-stat' && !fault.statFailed.has(args[0])))) {
        fault.statFailed.add(args[0]); throw new Error(`injected ${fault.kind}`)
      }
      return fs.fstatSync(...args)
    },
    writeSync: (...args: any[]) => {
      if (fault.kind === 'owner-write' && fault.paths.get(args[0])?.endsWith('owner.json')) {
        fs.writeSync(args[0], Buffer.from('{'), 0, 1, 0)
        throw new Error('injected owner-write')
      }
      return (fs.writeSync as (...args: any[]) => number)(...args)
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (fault.kind === 'owner-write' && typeof args[0] === 'number' && fault.paths.get(args[0])?.endsWith('owner.json')) {
        fs.writeSync(args[0], Buffer.from('{'), 0, 1, 0)
        throw new Error('injected owner-write')
      }
      return fs.writeFileSync(...args)
    },
    fsync: (fd: number, done: (error: NodeJS.ErrnoException | null) => void) => {
      if (fault.kind === 'owner-flush' && fault.paths.get(fd)?.endsWith('owner.json')) {
        fs.fsync(fd, () => {
          if (fault.replace) {
            const path = join(fault.root, '0', fault.replace)
            fs.renameSync(path, path + '.original')
            fs.writeFileSync(path, 'foreign bytes', { mode: 0o600 })
          }
          done(new Error('injected owner-flush'))
        })
      } else fs.fsync(fd, done)
    },
  }
})
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    if (fault.kind === 'history-open' && String(args[0]).endsWith('history.tmp')) throw new Error('injected history-open')
    const handle = await fs.open(...args)
    if (fault.kind === 'history-stat' && String(args[0]).endsWith('history.tmp')) {
      handle.stat = async () => { throw new Error('injected history-stat') }
    }
    return handle
  } }
})
const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
let root: string, stages: CheckpointStages
const leases: CheckpointStage[] = []
const destination = () => join(root, `${'a'.repeat(64)}-${'b'.repeat(36)}.history`)
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'checkpoint-allocation-failure-'))
  fault.root = join(root, '.stages'); fault.kind = ''; fault.replace = ''
  await mkdir(fault.root, { mode: 0o700 }); stages = new CheckpointStages(fault.root)
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  fault.kind = ''; fault.replace = ''
  for (const lease of leases.splice(0)) await lease.close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('unexposed checkpoint allocation failure', () => {
  it.each(['history-open', 'history-stat', 'owner-open', 'owner-stat', 'owner-write', 'owner-flush'])(
    'preserves capacity after four %s failures', async kind => {
      fault.kind = kind
      for (let attempt = 0; attempt < 4; attempt++) {
        await expect(stages.acquire(destination(), process.pid)).rejects.toThrow(`injected ${kind}`)
      }
      fault.kind = ''
      expect(fs.readdirSync(fault.root)).toEqual([])
      const lease = await stages.acquire(destination(), process.pid); leases.push(lease)
      expect(fs.existsSync(join(fault.root, '0', 'owner.json'))).toBe(true)
    })

  it('retains the whole allocation when owner identity remains unavailable', async () => {
    fault.kind = 'owner-stat-persistent'
    await expect(stages.acquire(destination(), process.pid)).rejects.toThrow('injected owner-stat-persistent')
    expect(fs.existsSync(join(fault.root, '0', 'history.tmp'))).toBe(true)
    expect(fs.existsSync(join(fault.root, '0', 'owner.json'))).toBe(true)
    expect(console.error).toHaveBeenCalledWith('[checkpoint] STAGE_CLEANUP_UNAVAILABLE')
  })

  it.each(['history.tmp', 'owner.json'])('preserves replaced %s on allocation failure', async name => {
    fault.kind = 'owner-flush'; fault.replace = name
    await expect(stages.acquire(destination(), process.pid)).rejects.toThrow('injected owner-flush')
    expect(fs.readFileSync(join(fault.root, '0', name), 'utf8')).toBe('foreign bytes')
    expect(fs.existsSync(join(fault.root, '0', name + '.original'))).toBe(true)
    expect(console.error).toHaveBeenCalledWith('[checkpoint] STAGE_CLEANUP_UNAVAILABLE')
  })
})
