/** Complete process topology for native conversation control; ordinary discovery remains best effort. */
import { readlink } from 'node:fs/promises'
import { NativeEvidenceBudget, nativeBytes, nativeProbe, nativeText, nativeUnavailable } from '../engines/kit/nativeEvidence.js'
import type { ProcessRow } from './tmux.js'
import type { ProcessIdentity } from './terminalTypes.js'
import { sameProcessIdentity } from './terminalRuntime.js'
import type { NativeDescriptor } from '../engines/kit/nativeDescriptors.js'
import { controlDescriptors, controlIdentity, linuxProcessStat, nativeProcessControl } from './nativeProcessControl.js'

type GraphRow = { pid: number; parentPid: number; state: string; startMarker: string }
export type NativeProcessRow = ProcessRow & { imagePath: string; evidence: string; controlIdentity?: string }
export interface ProcessEvidence {
  parent: NativeProcessRow | null
  children: readonly NativeProcessRow[]
  verify(selectedPid?: number): Promise<void>
  verifyDescriptors(pools: ReadonlyMap<number, readonly NativeDescriptor[]>, selectedPid?: number): Promise<void>
}
// Darwin's X is a traced/debugged modifier. Its '?' state is inconclusive: retain
// it as a possible owner/child for kernel verification, never as proven absence.
const alive = (state: string) => process.platform === 'darwin' ? state[0] !== 'Z' : !/^[ZXx]/.test(state)
const pidValue = (text: string) => {
  const value = Number(text)
  return Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff ? value : nativeUnavailable('the native process graph has an invalid pid')
}

/** Args and command names are separate: neither can inject a second graph row. */
export function parseProcessGraph(text: string, budget: NativeEvidenceBudget): Map<number, GraphRow> {
  if (!text || !text.endsWith('\n')) return nativeUnavailable('the native process graph is incomplete')
  const rows = new Map<number, GraphRow>()
  for (const line of text.slice(0, -1).split('\n')) {
    budget.step()
    const match = /^\s*(\d+)\s+(\d+)\s+([?A-Za-z+<>NsLsl-]{1,8})\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(line)
    if (!match || !Number.isFinite(Date.parse(match[4]))) return nativeUnavailable('the native process graph has an unreadable row')
    const pid = pidValue(match[1]), parentPid = pidValue(match[2])
    if (!pid || rows.has(pid) || rows.size >= 4096) return nativeUnavailable('the native process graph is duplicated or exceeds its limit')
    rows.set(pid, { pid, parentPid, state: match[3], startMarker: match[4] })
  }
  return rows
}

/** The comm field can contain spaces, parentheses and newlines; kernel fields follow its final ')'. */
const linuxStat = linuxProcessStat
const linuxIdentity = (row: ReturnType<typeof linuxStat>) => `${row.parentPid}:${row.startTicks}:${alive(row.state)}:${row.command}`
const imageSignature = (row: NativeProcessRow) => `${row.pid}:${row.parentPid}:${row.startTicks ?? row.startMarker}:${row.evidence}`

async function commandEvidence(row: GraphRow, budget: NativeEvidenceBudget): Promise<NativeProcessRow> {
  if (!alive(row.state)) return nativeUnavailable('the native process has exited')
  if (process.platform === 'linux') {
    const record = `/proc/${row.pid}/stat`
    const before = linuxStat(nativeText(await nativeBytes(record, 8192, budget)), row.pid)
    if (!alive(before.state) || before.parentPid !== row.parentPid) return nativeUnavailable('the native process changed before inspection')
    budget.step()
    const imagePath = await readlink(`/proc/${row.pid}/exe`).catch(() => nativeUnavailable('the native process image could not be read'))
    const bytes = await nativeBytes(`/proc/${row.pid}/cmdline`, 64 * 1024, budget)
    if (!bytes.length || bytes[bytes.length - 1] !== 0 || !imagePath.startsWith('/') || imagePath.endsWith(' (deleted)')) {
      return nativeUnavailable('the native process command is incomplete')
    }
    const argv = nativeText(bytes).slice(0, -1).split('\0')
    if (!argv[0]) return nativeUnavailable('the native process command is empty')
    // This display string is never token authority. /proc supplies the actual argv boundaries.
    const args = argv.join(' ')
    const after = linuxStat(nativeText(await nativeBytes(record, 8192, budget)), row.pid)
    budget.step()
    const finalImage = await readlink(`/proc/${row.pid}/exe`).catch(() => '')
    budget.step()
    if (linuxIdentity(before) !== linuxIdentity(after) || finalImage !== imagePath) return nativeUnavailable('the native process changed while its command was read')
    return { ...row, executable: before.command, args, startTicks: before.startTicks, imagePath,
      nativeArgv: argv, evidence: JSON.stringify([imagePath, before.command, argv]),
      controlIdentity: controlIdentity({ pid: row.pid, parentPid: before.parentPid, command: before.command, imagePath, argv, birth: String(before.startTicks) }) }
  }
  const native = (await nativeProcessControl([row.pid], 0, budget)).rows.get(row.pid)!
  if (native.parentPid !== row.parentPid || Number(native.birth.split(':')[0]) !== Date.parse(row.startMarker) / 1000) {
    return nativeUnavailable('the native process changed before inspection')
  }
  // Keep comm before another column, exactly as discovery does. BSD ps prints the
  // entire rewritten title when comm is last, turning healthy `codex --flags` into
  // an executable mismatch with discovery's fixed-width `codex` column.
  const text = await nativeProbe('ps', ['-ww', '-p', String(row.pid), '-o', 'ppid=,state=,comm=,lstart=,args='], budget, 64 * 1024)
  if (!text.endsWith('\n') || text.includes('\0')) return nativeUnavailable('the native process command is incomplete')
  const match = /^\s*(\d+)\s+(\S+)\s+([^\r\n]+?)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([^\r\n]*)\n$/.exec(text)
  if (!match || pidValue(match[1]) !== row.parentPid || !alive(match[2]) || match[4] !== row.startMarker) return nativeUnavailable('the native process command has changed ownership')
  const executable = match[3].trim(), args = match[5].trim()
  if (!executable || !args) return nativeUnavailable('the native process command is ambiguous')
  const after = (await nativeProcessControl([row.pid], 0, budget)).rows.get(row.pid)!
  if (controlIdentity(after) !== controlIdentity(native)) return nativeUnavailable('the native process changed while its command was read')
  return { ...row, executable, args, imagePath: native.imagePath,
    evidence: controlIdentity(native), controlIdentity: controlIdentity(native) }
}

/** Every direct child is inspected before classification. Never follow a nested tool process. */
export async function readProcessEvidence(pid: number, budget: NativeEvidenceBudget,
  includeChildren: (row: NativeProcessRow) => boolean | Promise<boolean> = () => false,
  expected?: ProcessIdentity,
): Promise<ProcessEvidence> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return nativeUnavailable('the native process id is invalid')
  const graph = () => nativeProbe('ps', ['-axo', 'pid=,ppid=,state=,lstart='], budget).then(text => parseProcessGraph(text, budget))
  const first = await graph(), initial = first.get(pid)
  if (!initial || !alive(initial.state)) {
    const verify = async () => {
      const current = (await graph()).get(pid)
      if (current && alive(current.state)) nativeUnavailable('the native process appeared during inspection')
    }
    return { parent: null, children: [], verify, verifyDescriptors: async pools => {
      if (pools.size) return nativeUnavailable('an absent native owner has descriptor evidence')
      await verify()
    } }
  }
  const parent = await commandEvidence(initial, budget)
  if (expected && (!sameProcessIdentity(parent, expected) || parent.executable !== expected.executable)) {
    return nativeUnavailable('the native process no longer matches the observed owner')
  }
  const followsChildren = await includeChildren(parent)
  const childRows = followsChildren ? [...first.values()].filter(row => row.parentPid === pid && alive(row.state)) : []
  if (childRows.length > 32) return nativeUnavailable('the native direct-child limit was reached')
  const children: NativeProcessRow[] = []
  for (const child of childRows) children.push(await commandEvidence(child, budget))
  const verify = async (selectedPid?: number) => {
    const current = await graph(), now = current.get(pid)
    if (!now || !alive(now.state)) return nativeUnavailable('the native process exited during inspection')
    const nextChildren = followsChildren ? [...current.values()].filter(row => row.parentPid === pid && alive(row.state)) : []
    if (nextChildren.map(row => row.pid).sort((a, b) => a - b).join(',') !== children.map(row => row.pid).sort((a, b) => a - b).join(',')) {
      return nativeUnavailable('the native direct-child set changed during inspection')
    }
    if (imageSignature(await commandEvidence(now, budget)) !== imageSignature(parent)) {
      return nativeUnavailable('the native owner changed during inspection')
    }
    for (const prior of [...children.filter(row => row.pid !== selectedPid), ...children.filter(row => row.pid === selectedPid)]) {
      if (imageSignature(await commandEvidence(current.get(prior.pid)!, budget)) !== imageSignature(prior)) {
        return nativeUnavailable('a native child changed during inspection')
      }
    }
  }
  await verify()
  const verifyDescriptors: ProcessEvidence['verifyDescriptors'] = async (pools, selectedPid) => {
    const all = [parent, ...children.filter(row => row.pid !== selectedPid), ...children.filter(row => row.pid === selectedPid)]
    if ([...pools.keys()].some(id => !all.some(row => row.pid === id))) return nativeUnavailable('the native descriptor owner is outside the process pool')
    const current = await nativeProcessControl(all.map(row => row.pid), followsChildren ? pid : 0, budget)
    if (current.children.slice().sort((a, b) => a - b).join(',') !== children.map(row => row.pid).sort((a, b) => a - b).join(',')) {
      return nativeUnavailable('the native direct-child set changed during inspection')
    }
    for (const prior of all) {
      const now = current.rows.get(prior.pid)!
      if (!prior.controlIdentity || controlIdentity(now) !== prior.controlIdentity) return nativeUnavailable('the native owner changed during descriptor inspection')
      const pool = pools.get(prior.pid)
      if (pool && controlDescriptors(now.fds) !== controlDescriptors(pool)) return nativeUnavailable('the native descriptor pool changed during process inspection')
    }
  }
  return { parent, children, verify, verifyDescriptors }
}
