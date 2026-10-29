/** Why a task was lost, as liveness.ts writes it, and what a Buddy reads instead (security re-check 2 of #2115): a Buddy reads
 *  no machines, so a reason that names one is worded without it, as a failed start's is for members (startFailure.ts). The
 *  Lead and people keep the full text. Nothing here imports, so liveness.ts and the read paths share it. */
export const sessionStopped = (machine: string): string => `its session on ${machine} stopped`
export const machineOffline = (machine: string): string => `its machine ${machine} has been offline for 2 minutes`

const SESSION_STOPPED = /^its session on .+ stopped$/s
const MACHINE_OFFLINE = /^its machine .+ has been offline for 2 minutes$/s

/** [reason] without its machine; every other reason names none and is kept as written. */
export function lostReasonWithoutMachine(reason: string): string {
  if (SESSION_STOPPED.test(reason)) return 'its session stopped'
  if (MACHINE_OFFLINE.test(reason)) return 'its machine has been offline for 2 minutes'
  return reason
}
