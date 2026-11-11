/** A machine its owner renamed in Machines (routes/machines.ts → MachineService.rename). Its Swarms read the new name from
 *  its account row (machines.ts accountMachineName), never from here. */
export interface MachineRename { machineId: string; ownerId: string; autonomousEnv: string }

type Listener = (rename: MachineRename) => Promise<unknown>
let listener: Listener | null = null

/** The Swarm routes' store takes renames from here (routes/superTabs.ts), so MachineService loads no Swarm code. */
export function onMachineRenamed(next: Listener | null): void {
  listener = next
}

/** Tells the Swarms the machine is in at once (Dee, #2308; review of #2717): one renamed while offline sends no reading,
 *  so it would keep its old name there until it reports again. Nothing to do when no Swarm routes run here. */
export async function machineRenamed(rename: MachineRename): Promise<void> {
  await listener?.(rename)
}
