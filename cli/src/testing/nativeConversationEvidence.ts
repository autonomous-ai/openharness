/** Private, complete evidence fixtures. They replace OS reads, never the control algorithm. */
import { stat } from 'node:fs/promises'
import { nativeUnavailable } from '../engines/kit/nativeEvidence.js'
import type { NativeDescriptor } from '../engines/kit/nativeDescriptors.js'
import type { NativeConversationSources } from '../lib/nativeConversation.js'
import type { NativeProcessRow } from '../lib/processEvidence.js'
import type { ProcessRow } from '../lib/tmux.js'
import { sameProcessIdentity } from '../lib/terminalRuntime.js'
import { controlDescriptors } from '../lib/nativeProcessControl.js'

type Row = Pick<ProcessRow, 'pid' | 'parentPid' | 'executable' | 'args'> & Partial<ProcessRow>
export function nativeConversationFixture(files: (pid: number) => Promise<string[]>,
  processes?: () => Promise<readonly Row[] | null>,
): NativeConversationSources {
  const row = (one: Row): NativeProcessRow => ({ startMarker: 'Fri Oct  9 11:59:00 2026', ...one,
    imagePath: one.imagePath ?? one.executable, evidence: JSON.stringify(one) })
  const sources: NativeConversationSources = {
    descriptors: async (pid, budget) => {
      const read = async () => {
        const names = await files(pid)
        if (names.length > 4096) return nativeUnavailable('the fixture descriptor pool is too large')
        const rows: NativeDescriptor[] = []
        for (const [index, path] of names.entries()) {
          budget.step()
          const info = await stat(path, { bigint: true }).catch(() => null)
          rows.push({ fd: String(index + 3), path, kind: !info || info.isFile() ? 'REG' : 'OTHER',
            device: info?.dev ?? 1n, inode: info?.ino ?? BigInt(pid * 4096 + index) })
        }
        return rows
      }
      const descriptors = await read()
      const text = (rows: NativeDescriptor[]) => JSON.stringify(rows, (_, value) => typeof value === 'bigint' ? String(value) : value)
      return { descriptors, verify: async () => {
        if (text(await read()) !== text(descriptors)) nativeUnavailable('the fixture descriptors changed')
      } }
    },
    processes: async (pid, budget, includeChildren = () => false, expected) => {
      const read = async () => {
        budget.step()
        const rows = processes ? await processes() : [{ pid, parentPid: 1, executable: '/fixture-tools/codex', args: 'codex' }]
        if (!rows) return nativeUnavailable('the native process graph is incomplete')
        return rows.map(row)
      }
      const rows = await read(), parent = rows.find(one => one.pid === pid) ?? null
      if (parent && expected && (!sameProcessIdentity(parent, expected) || parent.executable !== expected.executable)) return nativeUnavailable('the fixture process changed')
      const follows = parent ? await includeChildren(parent) : false
      const children = follows ? rows.filter(one => one.parentPid === pid) : []
      const projection = (rows: NativeProcessRow[]) => JSON.stringify(rows.filter(one => one.pid === pid || (follows && one.parentPid === pid)))
      const verify = async () => {
        if (projection(await read()) !== projection(rows)) nativeUnavailable('the fixture process changed')
      }
      return { parent, children, verify, verifyDescriptors: async pools => {
        await verify()
        for (const [owner, before] of pools) {
          const now = await sources.descriptors(owner, budget)
          if (controlDescriptors(now.descriptors) !== controlDescriptors(before)) nativeUnavailable('the fixture descriptors changed')
        }
      } }
    },
  }
  return sources
}
