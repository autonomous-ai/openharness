/**
 * The dial's host programs (herdr, WezTerm, Zellij, an X11 desktop, sway): each file that drives one is skipped where
 * the program is not installed, as on a developer's machine. CI's `e2e (dial hosts)` job (.github/workflows/cli-e2e.yml)
 * installs them all and sets `E2E_DIAL_HOSTS=1`, so there a missing one fails its file: a skip reads as a pass, and an
 * install step that broke would leave the job green with nothing tested.
 */

/** The files that job runs, and the eight shards leave out (vitest.e2e.dialHosts.config.ts, vitest.e2e.ci.config.ts). */
export const DIAL_HOST_FILES = ['e2e/dialHost*.e2e.ts', 'e2e/deviceHerdr.e2e.ts']

/** The host program found, or null to skip; on a dial-hosts run a null throws as the file loads, naming it. */
export function dialHost(name: string, found: string | null): string | null {
  if (found === null && process.env.E2E_DIAL_HOSTS === '1') throw new Error(`${name} is not installed on a dial-hosts run`)
  return found
}
