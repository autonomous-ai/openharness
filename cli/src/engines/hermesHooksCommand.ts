/**
 * `harness hermes-hooks`: the entries Harness adds to each Hermes home with a config, for one whose own `hooks:`
 * mapping Harness leaves alone (kit/nativeHookYaml.ts). They name the managed Node, notify.mjs and the person's
 * folders, so they are printed on the person's own terminal and the daemon's log only names this command.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { HERMES_HOOK_SETTINGS } from './hermes/contract.js'
import { manualHookEntries } from './kit/nativeHookYaml.js'
import { nativeHookHomes } from './kit/nativeHookHomes.js'
import { hermesHookCommand } from './nativeHooks.js'

/** [port]: the daemon's hook port, which the entries carry. */
export function hermesHooksCommand(port: number, print: (line: string) => void = console.log): void {
  for (const home of nativeHookHomes(HERMES_HOOK_SETTINGS.homes, HERMES_HOOK_SETTINGS.home)) {
    const config = join(home, HERMES_HOOK_SETTINGS.homes.file)
    if (!existsSync(config)) continue
    print(`# ${config}`)
    print(manualHookEntries(HERMES_HOOK_SETTINGS, hermesHookCommand(port, home)))
  }
}
