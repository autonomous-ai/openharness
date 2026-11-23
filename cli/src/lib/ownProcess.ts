/**
 * Whether this account's process [pid] runs. For a record one of this account's processes wrote (the daemon's, the
 * devices', the bridge's), EPERM is another account's process, one that took the pid since the recorded one exited and
 * could have made a pipe of its name (processProof.ts `pidAlive` counts it alive): not the recorded one.
 */
export function ownProcessRuns(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
