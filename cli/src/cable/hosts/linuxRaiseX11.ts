/**
 * The raise on any X11 desktop with an EWMH window manager (docs/plans/2026-11-19-dial-linux-design.md § 2.3): `wmctrl
 * -lpx` lists the windows, and `wmctrl -i -a <id>` brings the chosen one forward. The daemon may have no `DISPLAY` of its
 * own, so each command runs through `env` with the display and cookie the login exposes.
 */
import { isAgentPid } from './linuxDesktop.js'
import type { RaiseBackend, RaiseRun } from './linuxRaise.js'
import { RUN_TIMEOUT_MS } from './orca.js'

// wmctrl prints each id as `0x` and eight lowercase hex digits; anything else never reaches `-a`.
const WINDOW_ID = /^0x[0-9a-f]{1,8}$/
// `<id> <desktop> <pid> <instance>.<class> <host> <title>`, padded with spaces; a sticky window's desktop is -1.
const ROW = /^(\S+)\s+-?\d+\s+(\d+)\s+(\S+)/

interface Window { id: string; pid: number; wmClass: string }

const windowsOf = (listing: string): Window[] => listing.split('\n').flatMap((line) => {
  const row = ROW.exec(line)
  return row === null || !WINDOW_ID.test(row[1]) ? [] : [{ id: row[1], pid: Number(row[2]), wmClass: row[3].toLowerCase() }]
})

// Instance and class are joined by a dot and either may hold dots, so a spelling matches when it is one whole side.
const hasClass = (wmClass: string, spelling: string) => {
  const lower = spelling.toLowerCase()
  return wmClass.startsWith(`${lower}.`) || wmClass.endsWith(`.${lower}`)
}

export function createX11Raise(deps: RaiseRun, display: string, xauthority?: string): RaiseBackend {
  const wmctrl = async (env: string, args: string[]) => {
    const vars = [`DISPLAY=${display}`, ...(xauthority === undefined ? [] : [`XAUTHORITY=${xauthority}`])]
    return deps.run(env, [...vars, 'wmctrl', ...args], RUN_TIMEOUT_MS).catch(() => ({ code: null, stdout: '' }))
  }
  return {
    async raise({ pids, classes }) {
      const env = deps.onPath('env')
      if (env === null) return false
      const listed = await wmctrl(env, ['-lpx'])
      if (listed.code !== 0) return false
      const windows = windowsOf(listed.stdout)
      const byPid = pids.filter(isAgentPid).map((pid) => windows.find((window) => window.pid === pid)).find((window) => window !== undefined)
      const found = byPid ?? windows.find((window) => classes.some((spelling) => hasClass(window.wmClass, spelling)))
      if (found === undefined) return false
      return (await wmctrl(env, ['-i', '-a', found.id])).code === 0
    },
  }
}
