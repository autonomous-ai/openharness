/**
 * The watch on the Claude app's store and the ChatGPT app's Codex home, for tier A (`DevicesDeps.watchStore`): no folder
 * of this machine is watched, and a step that writes a fixture file says so (`changed`), so the devices hear of it at a
 * moment the scenario chooses, the same on every host.
 *
 * Each registration keeps watchNearest's rules (cable/hosts/folderWatch.ts): it holds the nearest existing folder of its
 * list and hears what fs.watch tells of that folder alone, the name of an entry in it, never of one below. LOOK_MS after
 * any registration starts, stops or moves, every one held looks once: it moves to a nearer folder made since and tells a
 * change with no name. One none of whose folders is there holds nothing and never looks. A Windows store's folders, on
 * the Mac or Linux host tier A runs on, are this host's folders of the same names (onHost), where its fixture is.
 */
import { existsSync } from 'node:fs'
import { basename, dirname, sep } from 'node:path'
import type { DevicesDeps } from '../../../services/devices.js'

/** folderWatch.ts LIVE_MS: how long after a watch starts or closes every watch held looks once more. */
const LOOK_MS = 5_000

/** This host's folder for a store's path: a Windows path the devices made of this host's home (appPlaces.ts joins it
 *  with win32's separator) is that folder with its own separator back. */
export const onHost = (path: string): string => (sep === '/' ? path.replaceAll('\\', '/') : path)

interface Registration {
  folders: readonly string[]
  changed: (file?: string) => void
  /** The index of the folder held: the nearest of `folders` that was there. */
  held?: number
}

export function createStoreWatch(): { watch: NonNullable<DevicesDeps['watchStore']>; changed(path: string): void } {
  const registrations = new Set<Registration>()
  /** The registrations that hold a folder, each of which looks. */
  const holding = new Set<Registration>()
  let look: ReturnType<typeof setTimeout> | undefined
  const rebuilt = (): void => {
    clearTimeout(look)
    look = holding.size === 0 ? undefined : setTimeout(() => {
      look = undefined
      // A look's caller can stop another registration, which is then not looked at.
      for (const registration of [...holding]) {
        if (!holding.has(registration)) continue
        hold(registration)
        registration.changed()
      }
    }, LOOK_MS)
  }
  /** Out of a folder that is gone, then to the nearest one there. */
  const hold = (registration: Registration): void => {
    const { folders } = registration
    if (registration.held !== undefined && !existsSync(folders[registration.held]!)) {
      registration.held = undefined
      if (holding.delete(registration)) rebuilt()
    }
    for (let at = 0; at < (registration.held ?? folders.length); at++) {
      if (!existsSync(folders[at]!)) continue
      registration.held = at
      holding.add(registration)
      rebuilt()
      return
    }
  }
  return {
    watch(folders, changed) {
      const registration: Registration = { folders: folders.map(onHost), changed }
      registrations.add(registration)
      hold(registration)
      return () => {
        registrations.delete(registration)
        if (holding.delete(registration)) rebuilt()
      }
    },
    changed(path) {
      for (const registration of [...registrations]) {
        // A registration an earlier one's caller stopped hears nothing more.
        if (!registrations.has(registration) || registration.held === undefined) continue
        if (registration.folders[registration.held] !== dirname(path)) continue
        hold(registration)
        registration.changed(basename(path))
      }
    },
  }
}
