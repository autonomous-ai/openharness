/** The native guard may replace only its own still-current shell, inside tmux. */
import { shellSingleQuote } from './shellQuote.js'

export const NATIVE_LAUNCH_MARKER = 'HARNESS_NATIVE_LAUNCH_TOKEN'

/** An inline launch script mentions the held command before it ever runs it. */
export function heldPaneFormat(token: string): string {
  return `#{&&:#{==:#{m:*${NATIVE_LAUNCH_MARKER}=*,#{pane_start_command}},0},#{&&:#{m:*harness-held*,#{pane_start_command}},#{m:*${token}*,#{pane_start_command}}}}`
}

export function nativePaneHold(token: string, tmuxBinary: string | null, heldCommand: string, node: string, owner: string): string {
  // This tag is captured by core, never read from a post-rc environment. Older
  // tmux keeps pane ownership in this prefix when a pane moves between windows.
  if (!/^[a-f0-9]{16}$/.test(owner)) throw new Error('Invalid native pane owner')
  const command = `/usr/bin/env HARNESS_DAEMON=${owner} ${heldCommand}`
  // Rc files can change TMUX and TMUX_PANE; neither grants authority. The target
  // must still contain this exact live shell PID and this launch's original nonce.
  // The predicate and respawn run together in the server. A timed-out client can
  // leave a queued command, which cannot replace a newer pane occupant.
  const publish = [
    'const [tmux,pane,pid,nonce,held]=process.argv.slice(1);',
    'if(/^%[0-9]+$/.test(pane)&&/^[0-9]+$/.test(pid)){',
    'const proof="#{&&:#{==:#{pane_id},"+pane+"},#{&&:#{==:#{pane_pid},"+pid+"},#{m:*"+nonce+"*,#{pane_start_command}}}}";',
    'try{require("node:child_process").execFileSync(tmux,["if-shell","-F","-t",pane,proof,"respawn-pane -k -t "+pane+" "+held],',
    '{timeout:2000,killSignal:"SIGKILL",stdio:"ignore"})}catch{}}',
  ].join('')
  const transition = tmuxBinary ? `${shellSingleQuote(node)} -e ${shellSingleQuote(publish)} ${shellSingleQuote(tmuxBinary)} "${'${TMUX_PANE:-}'}" "$$" ${shellSingleQuote(`${NATIVE_LAUNCH_MARKER}=${token}`)} ${shellSingleQuote(command)}\n` : ''
  // A missing or stalled server still leaves an inert shell, never an engine.
  return transition + `exec ${command}`
}
