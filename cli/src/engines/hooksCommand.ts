/**
 * `harness hooks hermes`: the entries Harness adds to each Hermes home with a config, for one whose own `hooks:`
 * mapping Harness leaves alone (kit/nativeHookYaml.ts). They name the managed Node, notify.mjs and the person's
 * folders, so they are printed on the person's own terminal and the daemon's log only names this command. They are built
 * from this shell's environment, as the daemon builds its own from its: a daemon started with another one installs other
 * entries. Hermes is the one engine: Harness writes every other engine's hooks itself.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { HERMES_HOOK_SETTINGS } from './hermes/contract.js'
import { manualHookEntries } from './kit/nativeHookYaml.js'
import { nativeHookHomes } from './kit/nativeHookHomes.js'
import { hermesHookCommand } from './nativeHooks.js'

/** [port]: the daemon's hook port, which the entries carry. Answers the exit code. */
export function hooksCommand(
  engine: string | undefined, port: number,
  print: (line: string) => void = console.log, error: (line: string) => void = console.error,
): number {
  if (engine !== 'hermes') {
    error('Usage: harness hooks hermes   (Harness writes the other engines\' hooks itself)')
    return 1
  }
  for (const home of nativeHookHomes(HERMES_HOOK_SETTINGS.homes, HERMES_HOOK_SETTINGS.home)) {
    const config = join(home, HERMES_HOOK_SETTINGS.homes.file)
    if (!existsSync(config)) continue
    print(`# ${config}`)
    print(manualHookEntries(HERMES_HOOK_SETTINGS, hermesHookCommand(port, home)))
  }
  return 0
}
