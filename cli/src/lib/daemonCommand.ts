/**
 * How an agent's shell runs this harness's CLI against the daemon it runs under: this process's Node (the
 * stable path, never a versioned one an update removes: harnessd/baseNode.ts), its flags (tsx's loader, run
 * from the sources) and its script, each quoted for a POSIX shell. The orchestrator writes it into the
 * prompts of the agents it runs (`… orchestrator --port 18473`), as the socket did while it ran inside it.
 * Read in the core's process, whose script is the CLI: a service's process may run the lean bundle instead.
 */
import { baseNode } from '../harnessd/baseNode.js'

const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`

export function daemonCommand(execPath = process.execPath, execArgv: readonly string[] = process.execArgv, script = process.argv[1]): string {
  return [baseNode(execPath), ...execArgv, script].map(quote).join(' ')
}
