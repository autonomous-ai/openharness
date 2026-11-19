/** Packaged daemon custody: storage belongs to its one live core and executes that same admitted entry. */
interface ProcessRow { pid: number; ppid: number; command: string }
export function daemonOwnsProcesses(rows: readonly ProcessRow[], master: number): boolean {
  const cores = rows.filter(row => row.ppid === master && row.command.endsWith(' __run'))
  if (cores.length !== 1 || !rows.some(row => row.pid === master)) return false
  const core = cores[0], entry = / (\S+) __run$/.exec(core.command)?.[1]
  const storage = rows.filter(row => row.command.endsWith(' __storage'))
  if (!entry || storage.length > 1) return false
  return rows.every(row => row.pid === master
    || row.ppid === master && / __(?:run|service \S+)$/.test(row.command)
    || row.ppid === core.pid && row.command.endsWith(` ${entry} __storage`))
}
