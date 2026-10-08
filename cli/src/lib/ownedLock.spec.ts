import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownedLock } from './ownedLock.js'
import { processStartMarker } from './processLiveness.js'

// The daemon spawn lock's own spec (daemonSpawnLock.spec.ts) covers these mechanics through that lock;
// this one holds them to what a second lock, the agent install lock, relies on.
let root = ''
const children: ChildProcess[] = []
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'owned-lock-')) })
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  rmSync(root, { recursive: true, force: true })
})

const lockAt = (ownerlessStaleMs = 5_000) => ownedLock({ dir: join(root, 'state', 'x.lock'), parent: join(root, 'state'), label: 'test lock', ownerlessStaleMs })
const ownerFile = () => join(root, 'state', 'x.lock', 'owner.json')

/** Write an owner record as another process would have. */
function plant(record: Record<string, unknown>): void {
  mkdirSync(join(root, 'state', 'x.lock'), { recursive: true, mode: 0o700 })
  chmodSync(join(root, 'state'), 0o700)
  chmodSync(join(root, 'state', 'x.lock'), 0o700)
  writeFileSync(ownerFile(), JSON.stringify(record), { mode: 0o600 })
}

describe('ownedLock', () => {
  it('records this process and the fields asked for, and lets go only with its own token', () => {
    const lock = lockAt()
    const token = lock.tryCreate({ purpose: 'pane', engine: 'opencode' })!
    expect(token).toEqual(expect.any(String))
    expect(lock.read()).toMatchObject({ pid: process.pid, token, fields: { purpose: 'pane', engine: 'opencode' } })
    expect(lock.tryCreate({ purpose: 'background' })).toBeNull()
    lock.releaseOwnedBy('someone-else')
    expect(existsSync(lock.dir)).toBe(true)
    lock.releaseOwnedBy(token)
    expect(existsSync(lock.dir)).toBe(false)
  })

  it('lets exactly one of many racing processes create it (mkdir, then an O_EXCL owner)', async () => {
    const script = join(root, 'race.mts')
    writeFileSync(script, `import { ownedLock } from ${JSON.stringify(new URL('./ownedLock.ts', import.meta.url).pathname)}
const lock = ownedLock({ dir: process.argv[2], parent: process.argv[3], label: 'test lock', ownerlessStaleMs: 5000 })
// All of them try at once, as close as their start-up allows.
await new Promise((resolve) => setTimeout(resolve, Number(process.argv[4]) - Date.now()))
process.stdout.write(lock.tryCreate({}) ? 'won' : 'lost')
`)
    const tsx = new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url).pathname
    const at = String(Date.now() + 4_000)
    const runs = await Promise.all(Array.from({ length: 6 }, () => new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [tsx, script, join(root, 'state', 'x.lock'), join(root, 'state'), at], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      child.stdout!.on('data', (chunk) => { out += chunk })
      child.on('close', () => resolve(out))
    })))
    expect(runs.filter((out) => out === 'won')).toHaveLength(1)
    expect(runs.filter((out) => out === 'lost')).toHaveLength(5)
  }, 60_000)

  it('takes an empty owner record for a lock being made, then for debris once past its grace', () => {
    const lock = lockAt(5_000)
    plant({})
    writeFileSync(ownerFile(), '', { mode: 0o600 })
    expect(lock.read()).toBeNull()
    expect(lock.reclaimIfOwnerless()).toBe(false)
    const old = (Date.now() - 6_000) / 1000
    utimesSync(ownerFile(), old, old)
    utimesSync(lock.dir, old, old)
    expect(lock.reclaimIfOwnerless()).toBe(true)
    expect(existsSync(lock.dir)).toBe(false)
  })

  it('reclaims a lock whose holder is gone, or whose pid now runs another process', () => {
    const lock = lockAt()
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!
    plant({ pid: dead, startMarker: '', token: 'a', since: Date.now() })
    expect(lock.reclaimIfStale(lock.read()!)).toBe(true)

    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100000)'], { stdio: 'ignore' })
    children.push(live)
    const marker = processStartMarker(live.pid!) ?? 'ps-c:'
    plant({ pid: live.pid, generationMarker: `${marker.split(':')[0]}:Thu Jan  1 00:00:00 1970`, token: 'b', since: Date.now() })
    expect(lock.reclaimIfStale(lock.read()!)).toBe(true)
  })

  it('never ages out a live holder that checks out by its start', () => {
    const lock = lockAt()
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100000)'], { stdio: 'ignore' })
    children.push(live)
    plant({ pid: live.pid, generationMarker: processStartMarker(live.pid!) ?? '', token: 'c', since: Date.now() - 365 * 24 * 3600_000 })
    expect(lock.reclaimIfStale(lock.read()!)).toBe(false)
    expect(lock.tryCreate({})).toBeNull()
    expect(existsSync(lock.dir)).toBe(true)
  })

  it('refuses what it would not have made, rather than trusting or removing it', () => {
    const lock = lockAt()
    mkdirSync(join(root, 'state'), { recursive: true, mode: 0o700 })
    mkdirSync(lock.dir, { mode: 0o755 })
    chmodSync(lock.dir, 0o755)
    expect(() => lock.read()).toThrow(/test lock .* has an unsafe owner, mode, or type/)
    expect(lock.reclaimIfOwnerless()).toBe(false)
    expect(existsSync(lock.dir)).toBe(true)
  })
})
