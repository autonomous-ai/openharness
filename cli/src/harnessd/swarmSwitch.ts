/**
 * The Swarm switch. The Swarm (Super Tabs, src/superTabs/) is a subsystem a computer can run without (Dee, v1's last
 * item: the daemon core stays small and reliable): `HARNESS_SWARM=off` (or `0`, `false`, `no`) leaves its service out
 * of every process the master starts (harnessd/services.ts `servicesOn`), and the core and the services that act on it
 * then load none of its code (core/main.ts, serviceProcess.ts). Unset, or anything else, it is on, as it was before
 * there was a switch. Read once, as each process starts, from the environment the master hands on.
 *
 * Its own file, with no imports, so a service's process reads it without loading the master's code.
 */
export const SWARM_ENV = 'HARNESS_SWARM'

export function swarmOn(env: NodeJS.ProcessEnv): boolean {
  return !['off', '0', 'false', 'no'].includes((env[SWARM_ENV] ?? '').trim().toLowerCase())
}
