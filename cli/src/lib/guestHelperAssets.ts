import { readFileSync } from 'node:fs'

declare const __GUEST_HELPER__: string
declare const __GUEST_SUDOERS__: string

// The release bundle carries both files inside cli.js (build-bundle.mjs `define`): the installed CLI is
// cli.js and notify.mjs alone, with nothing beside them to read. A dev checkout and the tests read the
// files themselves, from cli/assets/guest-helper (src/lib/ and dist/lib/ are both two levels down).
function asset(bundled: string | undefined, name: string): string {
  return bundled ?? readFileSync(new URL(`../../assets/guest-helper/${name}`, import.meta.url), 'utf8')
}

/** The guest helper's script (cli/assets/guest-helper/guest-helper.sh). */
export function guestHelperScript(): string {
  return asset(typeof __GUEST_HELPER__ === 'string' ? __GUEST_HELPER__ : undefined, 'guest-helper.sh')
}

/** The sudoers drop-in's template, `{{OWNER}}` still in it (cli/assets/guest-helper/sudoers). */
export function guestSudoersTemplate(): string {
  return asset(typeof __GUEST_SUDOERS__ === 'string' ? __GUEST_SUDOERS__ : undefined, 'sudoers')
}

/** The helper script's own version (its `HELPER_VERSION=`), or null when it names none. */
export function helperScriptVersion(script: string): number | null {
  const match = /^HELPER_VERSION=(\d+)$/m.exec(script)
  return match ? Number(match[1]) : null
}
