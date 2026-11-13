/** A fixture `/proc` under a temporary folder; the real `/proc` is never read. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearProcessViews, processView } from './processMounts.js'

// Every call into `node:fs/promises`, by the path it was given: what a view read.
const reads = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async original => {
  const fs = await original<Record<string, unknown>>()
  return Object.fromEntries(Object.entries(fs).map(([name, value]) => [name, typeof value === 'function'
    ? (...args: unknown[]) => { reads.push(String(args[0])); return Reflect.apply(value, fs, args) }
    : value]))
})

const ours = '25 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n40 25 8:17 / /data rw - ext4 /dev/sdb1 rw\n26 25 0:22 / /tmp rw - tmpfs tmpfs rw\n'
const remapped = '90 80 8:1 / / rw - ext4 /dev/sda1 rw\n91 90 8:17 /agents/a1 /home/agent rw - ext4 /dev/sdb1 rw\n'
  + '92 90 8:17 /work/p1 /work rw - ext4 /dev/sdb1 rw\n93 90 0:71 / /tmp rw - tmpfs tmpfs rw\n'
const identity = { pid: 4242, startMarker: '2026-11-12T10:00:00Z', executable: 'python3' }
const MiB = 1 << 20

let proc = ''
// `unlinkSync`, not `rmSync`: the fixture's links point at nothing, and Node 23's `rmSync` leaves such a link in place.
function unlink(file: string) {
  try { unlinkSync(file) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
function link(pid: number | 'self', target: string) {
  const file = join(proc, String(pid), 'ns', 'mnt')
  unlink(file)
  symlinkSync(target, file)
}
beforeEach(() => {
  clearProcessViews()
  proc = mkdtempSync(join(tmpdir(), 'process-mounts-'))
  for (const pid of ['self', '4242']) mkdirSync(join(proc, pid, 'ns'), { recursive: true })
  link('self', 'mnt:[4026531841]')
  link(4242, 'mnt:[4026532999]')
  writeFileSync(join(proc, 'self', 'mountinfo'), ours)
  writeFileSync(join(proc, '4242', 'mountinfo'), remapped)
  symlinkSync('/work/src', join(proc, '4242', 'cwd'))
  reads.length = 0
})
afterEach(() => { rmSync(proc, { recursive: true, force: true }) })

it('reads nothing off Linux', async () => {
  expect(await processView(identity, 'darwin', '/nonexistent')).toEqual({ state: 'same' })
  expect(reads).toEqual([])
})

it('is the daemon\'s own view in the daemon\'s namespace', async () => {
  link(4242, 'mnt:[4026531841]')
  expect(await processView(identity, 'linux', proc)).toEqual({ state: 'same' })
})

it('translates a sandboxed process\'s paths, and names its folder as it names it', async () => {
  const view = await processView(identity, 'linux', proc)
  expect(view).toMatchObject({ state: 'sandbox', cwd: '/work/src' })
  if (view.state !== 'sandbox') throw new Error('unreachable')
  expect(view.toHost('/home/agent/.hermes')).toBe('/data/agents/a1/.hermes')
  expect(view.toHost('/work/src')).toBe('/data/work/p1/src')
  expect(view.toHost('/tmp/x')).toBeNull()
})

it('cannot translate when a mountinfo is unreadable or oversized, and cannot tell when the namespace is', async () => {
  rmSync(join(proc, '4242', 'mountinfo'))
  unlink(join(proc, '4242', 'cwd'))
  const unread = await processView(identity, 'linux', proc)
  expect(unread).toMatchObject({ state: 'sandbox', cwd: null })
  expect((unread as { toHost(p: string): string | null }).toHost('/home/agent')).toBeNull()

  writeFileSync(join(proc, '4242', 'mountinfo'), remapped)
  const padded = (text: string, size: number) => text + '#'.repeat(size - text.length - 1) + '\n'
  writeFileSync(join(proc, 'self', 'mountinfo'), padded(ours, MiB))
  clearProcessViews()
  expect((await processView(identity, 'linux', proc) as { toHost(p: string): string | null }).toHost('/home/agent')).toBe('/data/agents/a1')
  writeFileSync(join(proc, 'self', 'mountinfo'), padded(ours, MiB + 1))
  clearProcessViews()
  expect((await processView(identity, 'linux', proc) as { toHost(p: string): string | null }).toHost('/home/agent')).toBeNull()

  clearProcessViews(); unlink(join(proc, '4242', 'ns', 'mnt'))   // each view above was kept
  expect(await processView(identity, 'linux', proc)).toEqual({ state: 'unreadable' })
  link(4242, 'mnt:[4026532999]'); unlink(join(proc, 'self', 'ns', 'mnt'))
  expect(await processView(identity, 'linux', proc)).toEqual({ state: 'unreadable' })
})

it('reads a process once, and another process again', async () => {
  const first = await processView(identity, 'linux', proc)
  expect(reads).not.toEqual([])
  reads.length = 0
  expect(await processView(identity, 'linux', proc)).toBe(first)
  expect(reads).toEqual([])

  link(4242, 'mnt:[4026531841]')
  expect(await processView({ ...identity, startMarker: '2026-11-12T11:00:00Z' }, 'linux', proc)).toEqual({ state: 'same' })
  expect(reads).not.toEqual([])
  reads.length = 0
  expect(await processView({ ...identity, startMarker: '2026-11-12T11:00:00Z' }, 'linux', proc)).toEqual({ state: 'same' })
  expect(reads).toEqual([])

  const gone = { ...identity, pid: 5151 }
  expect(await processView(gone, 'linux', proc)).toEqual({ state: 'unreadable' })
  reads.length = 0
  expect(await processView(gone, 'linux', proc)).toEqual({ state: 'unreadable' })
  expect(reads).not.toEqual([])
})

it('keeps at most 256 processes, and starts over past them', async () => {
  const nth = (n: number) => ({ ...identity, startMarker: `start ${n}` })
  for (let n = 0; n < 256; n++) await processView(nth(n), 'linux', proc)
  reads.length = 0
  await processView(nth(0), 'linux', proc)
  expect(reads).toEqual([])
  await processView(nth(256), 'linux', proc)
  reads.length = 0
  await processView(nth(0), 'linux', proc)
  expect(reads).not.toEqual([])
})
