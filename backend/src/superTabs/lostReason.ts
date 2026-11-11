/** Why a task was lost, as liveness.ts writes it. */
export const sessionStopped = (machine: string): string => `its session on ${machine} stopped`
export const machineOffline = (machine: string): string => `its machine ${machine} has been offline for 2 minutes`
