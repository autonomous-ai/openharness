/**
 * `lib/patientExec.ts` with its deadline taken off, for a spec whose fake binary (a `/bin/sh` script on
 * PATH standing in for tmux or ps) is there to say what was asked and what came back, not how long it took.
 *
 * On a loaded machine one such script takes seconds to start. Under 12 busy loops on a 12-core Mac (load
 * 60) the product's 2 s and 3 s deadlines killed fake tmux and ps scripts before their first line ran: a
 * failed read the spec then counted as never made (processRows.spec.ts, tmuxVersion.spec.ts), and a pane
 * listing that read as no answer (tmuxLegacySessions.spec.ts). What a deadline does is patientExec.spec.ts's
 * to test. tmuxBackend.spec.ts does the same with a mock of its own, which also counts the calls in flight.
 *
 * Use it from a spec beside the module that imports patientExec:
 *   vi.mock('./patientExec.js', async (importOriginal) =>
 *     (await import('../testing/patientExecWithoutDeadline.js')).withoutDeadline(await importOriginal()))
 */
import type { ExecFileException } from 'node:child_process'
import type * as PatientExec from '../lib/patientExec.js'

export function withoutDeadline(actual: typeof PatientExec): typeof PatientExec {
  const patientExec: typeof actual.patientExec = (execFile) => (file, args, options, done) => {
    const { timeout: _timeout, killSignal: _killSignal, ...rest } = options
    execFile(file, [...args], { ...rest, encoding: 'utf8' }, (error: ExecFileException | null, stdout: string, stderr: string) => {
      done(error, stdout ?? '', stderr ?? '')
    })
  }
  return { ...actual, patientExec }
}
