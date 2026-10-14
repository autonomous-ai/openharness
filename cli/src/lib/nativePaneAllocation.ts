/** A pane stops belonging to its native allocation before an interactive shell
 * can start. The original tmux command and PID alone survive that transition. */
import { isAbsolute } from 'node:path'
import { HARNESS_OWNER_OPTION } from './harnessSessionLabel.js'
import { NATIVE_LAUNCH_MARKER } from './nativePaneHold.js'
import { shellSingleQuote } from './shellQuote.js'

export const NATIVE_PANE_ALLOCATION_OPTION = '@harness_native_allocation'
export interface NativePaneAllocation { pane: string; rootPid: number; token: string; owner: string }
type Operation = 'claim' | 'release' | 'close'
const all = (...parts: string[]) => parts.reduce((left, right) => `#{&&:${left},${right}}`)
const either = (left: string, right: string) => `#{||:${left},${right}}`
const equal = (key: string, value: string) => `#{==:#{${key}},${value}}`
const tokenValid = (token: string, owner: string) => /^[a-zA-Z0-9_-]{16,96}$/.test(token) && /^[a-f0-9]{16}$/.test(owner)

function commands(operation: Operation, pane: string, pid: string, token: string, owner: string): string[] {
  const prefix = `/usr/bin/env ${NATIVE_LAUNCH_MARKER}=${token} `
  const tagged = `/usr/bin/env HARNESS_DAEMON=${owner} ${prefix}`
  const starts = (value: string) => `#{m:${value}*,#{pane_start_command}}`
  const original = all(equal('pane_id', pane), equal('pane_pid', pid),
    equal(HARNESS_OWNER_OPTION, owner), either(starts(prefix), starts(tagged)))
  const active = `active:${token}:${pid}`, released = `released:${token}:${pid}`
  const owns = all(original, equal(NATIVE_PANE_ALLOCATION_OPTION, active))
  const ack = `display-message -p native-allocation-${operation}`
  const mismatch = 'display-message -p native-allocation-mismatch'
  if (operation === 'close') return ['if-shell', '-F', '-t', pane, owns, `kill-pane -t ${pane}`, mismatch]
  // Keep the released value instead of unsetting the option. A delayed claim
  // cannot reactivate this token after the same root has entered its shell.
  const predicate = operation === 'claim'
    ? all(original, equal('pane_dead', '0'), either(equal(NATIVE_PANE_ALLOCATION_OPTION, ''), equal(NATIVE_PANE_ALLOCATION_OPTION, active))) : owns
  const value = operation === 'claim' ? active : released
  const success = `set-option -p -t ${pane} ${NATIVE_PANE_ALLOCATION_OPTION} ${value} ; ${ack}`
  const otherwise = operation === 'release'
    ? `if-shell -F -t ${pane} '${all(original, equal(NATIVE_PANE_ALLOCATION_OPTION, released))}' '${ack}' '${mismatch}'` : mismatch
  return ['if-shell', '-F', '-t', pane, predicate, success, otherwise]
}

/** The predicate and mutation are one server-side command. A timed-out client
 * may leave that command queued, so read-side ownership is never sufficient. */
export function nativePaneAllocationArgs(operation: Operation, input: NativePaneAllocation): string[] {
  if (!tokenValid(input.token, input.owner) || !/^%[0-9]{1,20}$/.test(input.pane)
    || !Number.isSafeInteger(input.rootPid) || input.rootPid <= 1 || input.rootPid > 0x7fffffff) throw Error('Invalid native pane allocation')
  return commands(operation, input.pane, String(input.rootPid), input.token, input.owner)
}

/** Runs in the original wrapper, before exec or fallback. Both outcomes require
 * an acknowledged pane-local option; old tmux must hold rather than borrow a
 * window option. Failed or delayed publication leaves only an inert shell. */
export function nativePaneAllocationScript(operation: 'claim' | 'release', token: string,
  tmux: string | null, node: string, owner: string, waiting: string,
): string {
  if (!tokenValid(token, owner)) throw Error('Invalid native pane allocation')
  if (!tmux || !isAbsolute(tmux) || !isAbsolute(node)) return waiting + '\n'
  const args = commands(operation, '<pane>', '<pid>', token, owner)
  const script = [
    'const [pane,pid]=process.argv.slice(1);',
    'if(!/^%[0-9]{1,20}$/.test(pane)||!/^[1-9][0-9]*$/.test(pid)||!Number.isSafeInteger(Number(pid))||Number(pid)<=1||Number(pid)>0x7fffffff)process.exit(1);',
    `const args=${JSON.stringify(args)}.map(value=>value.replaceAll('<pane>',pane).replaceAll('<pid>',pid));`,
    `try{const reply=require('node:child_process').execFileSync(${JSON.stringify(tmux)},args,`,
    "{timeout:2000,killSignal:'SIGKILL',maxBuffer:1024,encoding:'utf8',stdio:['ignore','pipe','ignore']});",
    `if(reply.trim()!==${JSON.stringify(`native-allocation-${operation}`)})process.exit(1);`,
    '}catch{process.exit(1)}',
  ].join('')
  return `if ! ${shellSingleQuote(node)} -e ${shellSingleQuote(script)} "${'${TMUX_PANE:-}'}" "$$"; then\n${waiting}\nfi\n`
}
