/** Bounded executable probes and their caches belong to the setup process. */
import { execFile } from 'node:child_process'
import { patientDeadline } from '../../lib/patientExec.js'
import { windowsEngineArgv } from '../../lib/windows/launch.js'
import { nativeProcessEnvironment } from './nativeLocations.js'
import type { NativeExecutableSnapshot } from './versionData.js'

let probes = 0
/** What a probe's child said, once it exited by itself. A kill at its deadline, a signal, an output limit or a
 *  child that never started is no answer at all: null. */
export interface ProbeOutput { code: number; stdout: string; stderr: string }
/** Slots follow actual subprocess settlement, including deadline and output-limit kills. */
export async function readNativeProbe(executable: string, args: readonly string[], environment: Readonly<Record<string, string>>, execute: typeof execFile = execFile): Promise<ProbeOutput | null> {
  if (probes >= 8) return null
  probes++
  return new Promise(done => {
    let settled = false, answered = false
    let cancelDeadline = () => {}
    let drain: ReturnType<typeof setTimeout> | undefined
    const answer = (output: ProbeOutput | null) => { if (!answered) { answered = true; done(output) } }
    let child: ReturnType<typeof execFile>
    try {
      // Windows starts an npm shim's script under node, never the shim through cmd.exe, which Node refuses to run
      // without a shell (lib/windows/launch.ts); elsewhere [executable] as it is.
      const [program, ...programArgs] = windowsEngineArgv('the engine', [executable, ...args], { environment: nativeProcessEnvironment(environment) })
      // Node's timeout can discard unread output after a core stall, then
      // report exit 0. Keep its pipes and use discovery's patient deadline.
      child = execute(program!, programArgs, {
        env: nativeProcessEnvironment(environment), encoding: 'utf8', killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true,
      }, (error, stdout, stderr) => {
        settled = true; probes--; cancelDeadline(); clearTimeout(drain)
        // A numeric code is the child's own exit status. A spawn failure, a signal or the output
        // limit leaves a string or null there, and says nothing about the executable itself. A child that
        // exited by itself as its deadline passed answered all the same: only a live one is killed below.
        const code = !error ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null
        answer(code === null ? null : { code, stdout: stdout ?? '', stderr: stderr ?? '' })
      })
    } catch { probes--; answer(null); return }
    if (!settled) cancelDeadline = patientDeadline(5_000, () => {
      // An exited wrapper may leave a descendant holding its pipes. Signal
      // only our still-live child, then close our pipe ends after a short drain.
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') } catch { /* The reply still holds. */ }
      drain = setTimeout(() => {
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy()
        // An uninterruptible child retains its slot until the actual callback.
        answer(null)
      }, 250)
    })
    child.stdin?.end()
  })
}

/** Each engine executable's help, by the file's identity (its path, inode, size and times: kit/nativeVersion.ts) and the
 *  PATH it runs under. Its help, and that it runs at all, are facts about the installed file, not one launch: launches that
 *  ask together share one probe, and a held pass of many agents (a restore) never meets the probes' cap, nor does a
 *  relaunch or fork ask twice. Not keyed on the homes: help does not read them, and an agent's own home would bring the
 *  cap back. Only help the engine printed is kept, for a minute: an engine can break around its unchanged
 *  file (its Node uninstalled), and a launch after that is refused with its reason again. No answer or a failure is asked
 *  again. A new install, an upgrade or a finished download is a new identity, asked afresh. */
const helps = new Map<string, { help: Promise<ProbeOutput | null>; at: number }>()
const HELP_LIFE_MS = 60_000
/** At most this many installs, each under the PATH it runs with; beyond it the oldest goes. */
const HELP_LIMIT = 32
export function helpOf(executable: NativeExecutableSnapshot, environment: Readonly<Record<string, string>>,
  args: readonly string[] = ['--help'], execute: typeof execFile = execFile): Promise<ProbeOutput | null> {
  const key = `${executable.identity}\0${environment.PATH ?? ''}\0${args.join(' ')}`, at = performance.now()
  const known = helps.get(key)
  if (known && at - known.at < HELP_LIFE_MS) return known.help
  helps.delete(key)
  const help = readNativeProbe(executable.command, args, environment, execute)
  if (helps.size >= HELP_LIMIT) helps.delete(helps.keys().next().value!)
  helps.set(key, { help, at })
  void help.then(output => {
    const printed = output?.code === 0 && `${output.stdout}${output.stderr}`.trim() && executable.current()
    if (!printed && helps.get(key)?.help === help) helps.delete(key)
  })
  return help
}
