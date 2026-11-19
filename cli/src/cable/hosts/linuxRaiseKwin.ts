/**
 * KDE's raise (docs/plans/2026-11-19-dial-linux-design.md § 2.3): KWin takes a script only as a file and passes it no
 * arguments, so each raise writes the fixed script below with the checked pids and classes filled in as JSON, then
 * loads, runs and unloads it over the session bus. A KWin script cannot say whether it found a window, so a run that
 * answered is a raise (plan: "KDE answers true once its script ran").
 */
import { join } from 'node:path'
import type { RaiseBackend, RaiseRun } from './linuxRaise.js'
import { RUN_TIMEOUT_MS } from './orca.js'

export interface KwinRaiseDeps extends RaiseRun {
  /** `<runtime>/harness`, private to this login. */
  dir: string
  /** Writes the file 0600, making `dir` 0700 first when it is not there. */
  write(path: string, text: string): void
  /** Never throws: a file already gone is no error. */
  remove(path: string): void
  /** Unique per raise: two raises at once must not load or remove each other's script. */
  name(): string
}

// Every value reaches the script as JSON: a class in this form needs no escape, and nothing else is let in.
const CLASS = /^[A-Za-z0-9._-]{1,64}$/
// A load answers the script's id (RECORDED_KWIN.loadScript); KWin answers -1 for a name loaded already, no script's.
const SCRIPT_ID = /^\s*int32 ([0-9]{1,10})$/m

/** The text that ran on Plasma 6 and 5 alike (RECORDED_KWIN.raiseScript): Plasma 6 names the API windowList and
 *  activeWindow, Plasma 5 clientList and activeClient. The first pid that owns a window wins, in the chain's order. */
const script = (pids: readonly number[], classes: readonly string[]) =>
  `var pids = ${JSON.stringify(pids)};\n` +
  `var classes = ${JSON.stringify(classes)};\n` +
  'var hasWindows = typeof workspace.windowList === "function";\n' +
  'var list = hasWindows ? workspace.windowList() : workspace.clientList();\n' +
  'var hit = null;\n' +
  'for (var p = 0; p < pids.length && !hit; p++) for (var i = 0; i < list.length; i++) if (list[i].pid === pids[p]) { hit = list[i]; break; }\n' +
  'for (var c = 0; c < classes.length && !hit; c++) for (var j = 0; j < list.length; j++) if (String(list[j].resourceClass).toLowerCase() === classes[c].toLowerCase()) { hit = list[j]; break; }\n' +
  'if (hit) { if (hasWindows) workspace.activeWindow = hit; else workspace.activeClient = hit; }\n'

export function createKwinRaise(deps: KwinRaiseDeps, bus: string): RaiseBackend {
  return {
    async raise(target) {
      // A window that names no process has pid 0, and pid 1 is no agent's: a whole number above 1, as linuxRaise takes.
      const pids = target.pids.filter((pid) => Number.isSafeInteger(pid) && pid > 1)
      const classes = target.classes.filter((spelling) => CLASS.test(spelling))
      if (pids.length === 0 && classes.length === 0) return false
      const dbusSend = deps.onPath('dbus-send')
      if (!dbusSend) return false
      const call = (path: string, method: string, ...args: string[]) =>
        deps.run(dbusSend, [`--bus=${bus}`, '--print-reply', '--dest=org.kde.KWin', path, method, ...args], RUN_TIMEOUT_MS)
          .catch(() => ({ code: null, stdout: '' }))
      const name = deps.name()
      const file = join(deps.dir, `raise-${name}.js`)
      const plugin = `harness-raise-${name}`
      try {
        deps.write(file, script(pids, classes))
        const load = await call('/Scripting', 'org.kde.kwin.Scripting.loadScript', `string:${file}`, `string:${plugin}`)
        if (load.code !== 0) return false
        try {
          const id = SCRIPT_ID.exec(load.stdout)?.[1]
          if (id === undefined) return false
          // Plasma 6 serves a script at /Scripting/Script<id>, Plasma 5 at /<id> (RECORDED_KWIN.plasma5.run); a run at
          // the other's path is an error at once. A run that did not answer is not asked again: a second would wait as long.
          const run = await call(`/Scripting/Script${id}`, 'org.kde.kwin.Script.run')
          if (run.code === 0) return true
          return run.code !== null && (await call(`/${id}`, 'org.kde.kwin.Script.run')).code === 0
        } finally {
          await call('/Scripting', 'org.kde.kwin.Scripting.unloadScript', `string:${plugin}`)
        }
      } catch {
        return false
      } finally {
        deps.remove(file)
      }
    },
  }
}
