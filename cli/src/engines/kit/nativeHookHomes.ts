/** Configured profiles need hooks before their first session creates a history store. */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface NativeHookHomes { directory: string; file: string; max: number }
export function nativeHookHomes(rule: NativeHookHomes, defaultHome: string): string[] {
  const homes = [defaultHome]
  let entries: string[] = []
  try { entries = readdirSync(join(defaultHome, rule.directory)) } catch { return homes }
  for (const name of entries.slice(0, rule.max)) {
    const home = join(defaultHome, rule.directory, name)
    try {
      if (statSync(join(home, rule.file)).isFile()) homes.push(home)
    } catch { /* not a profile folder, or no config yet */ }
  }
  return homes
}
