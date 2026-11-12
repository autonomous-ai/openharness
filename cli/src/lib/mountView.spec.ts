import { expect, it } from 'vitest'
import { hostPath, parseMountinfo } from './mountView.js'

const ours = parseMountinfo('25 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n40 25 8:17 / /data rw - ext4 /dev/sdb1 rw\n26 25 0:22 / /tmp rw - tmpfs tmpfs rw\n')
const remapped = parseMountinfo('90 80 8:1 / / rw - ext4 /dev/sda1 rw\n91 90 8:17 /agents/a1 /home/agent rw - ext4 /dev/sdb1 rw\n'
  + '92 90 8:17 /work/p1 /work rw - ext4 /dev/sdb1 rw\n93 90 0:71 / /tmp rw - tmpfs tmpfs rw\n')
it('translates a path to itself when the sandbox mounts it where the daemon does', () => {
  expect(hostPath('/data/agents/a1/.hermes', ours, ours)).toBe('/data/agents/a1/.hermes')
})
it('rebuilds the daemon\'s path of a remapped folder', () => {
  expect(hostPath('/home/agent/.hermes', remapped, ours)).toBe('/data/agents/a1/.hermes')
  expect(hostPath('/home/agent', remapped, ours)).toBe('/data/agents/a1')
  expect(hostPath('/work/src', remapped, ours)).toBe('/data/work/p1/src')
})
it('has no answer for a filesystem the daemon does not mount, or one it has covered', () => {
  expect(hostPath('/tmp/agent/.hermes', remapped, ours)).toBeNull()   // a private tmpfs: device 0:71
  const covered = [...ours, ...parseMountinfo('41 40 0:50 / /data/agents rw - tmpfs tmpfs rw\n')]
  expect(hostPath('/home/agent/.hermes', remapped, covered)).toBeNull()
})
it('has no answer through a mount that a later mount over its parent folder covers', () => {
  // The daemon's /data/agents (8:17) came first; a tmpfs mounted over /data since hides it, on the daemon's side or the
  // sandbox's. The deepest mount point over a path is not the mount it is on (proc(5), mountinfo's parent ID).
  const hidden = parseMountinfo('25 1 8:1 / / rw - ext4 /dev/sda1 rw\n40 25 8:17 / /data/agents rw - ext4 /dev/sdb1 rw\n'
    + '43 25 0:50 / /data rw - tmpfs tmpfs rw\n')
  expect(hostPath('/home/agent/.hermes', remapped, hidden)).toBeNull()
  const theirs = parseMountinfo('90 80 8:1 / / rw - ext4 /dev/sda1 rw\n91 90 8:17 /agents/a1 /home/agent rw - ext4 /dev/sdb1 rw\n'
    + '95 90 0:71 / /home rw - tmpfs tmpfs rw\n')
  expect(hostPath('/home/agent/.hermes', theirs, ours)).toBeNull()
  // One mounted on top of a mount point is that point's own child, and covers it.
  const onTop = [...ours, ...parseMountinfo('44 40 0:51 / /data rw - tmpfs tmpfs rw\n')]
  expect(hostPath('/home/agent/.hermes', remapped, onTop)).toBeNull()
})
it('has no answer from a mount list with no root', () => {
  expect(hostPath('/home/agent/.hermes', parseMountinfo('91 90 8:17 /agents/a1 /home/agent rw - ext4 /dev/sdb1 rw\n'), ours)).toBeNull()
  const loop = parseMountinfo('25 26 8:1 / / rw - ext4 /dev/sda1 rw\n26 25 8:1 / / rw - ext4 /dev/sda1 rw\n')
  expect(hostPath('/data', loop, loop)).toBeNull()
})
it('takes the mount on top, the deepest root, and escaped names', () => {
  const stacked = [...remapped, ...parseMountinfo('94 90 0:72 / /work rw - tmpfs tmpfs rw\n')]
  expect(hostPath('/work/src', stacked, ours)).toBeNull()
  const twice = [...ours, ...parseMountinfo('42 25 8:17 /agents /srv/agents rw - ext4 /dev/sdb1 rw\n')]
  expect(hostPath('/home/agent/.hermes', remapped, twice)).toBe('/srv/agents/a1/.hermes')
  expect(parseMountinfo('50 25 8:33 /my\\040disk /mnt/my\\040disk rw - ext4 /dev/sdc1 rw\n')).toEqual([{ device: '8:33', root: '/my disk', point: '/mnt/my disk' }])
  expect(parseMountinfo('garbage\n\n')).toEqual([])
})
it('refuses a path that is not absolute or climbs', () => {
  expect(hostPath('home/agent', remapped, ours)).toBeNull()
  expect(hostPath('/home/agent/../x', remapped, ours)).toBeNull()
})
