/**
 * The watch on the Claude app's store and the ChatGPT app's Codex home, for tier A (`DevicesDeps.watchStore`): no folder
 * of this machine is watched, and a step that writes a fixture file says so (`changed`), so the devices hear of it at a
 * moment the scenario chooses, the same on every host.
 *
 * Each registration holds the nearest existing folder of its list, as watchNearest does (cable/hosts/folderWatch.ts),
 * and hears what fs.watch tells of that folder: the name of an entry in it. A registration whose folders are not paths
 * of this host (a Windows store's on a Mac) holds none, and hears every change with no name, which says to look again.
 */
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, normalize } from 'node:path'
import type { DevicesDeps } from '../../../services/devices.js'

interface Registration {
  folders: readonly string[]
  changed: (file?: string) => void
  /** The folder held: the nearest of `folders` that exists. */
  held?: string
}

/** A path this host's file system takes as it is written: a Windows store's root on a Mac is not one. */
export const hostPath = (path: string): boolean => isAbsolute(path) && normalize(path) === path

const nearest = (folders: readonly string[]): string | undefined => folders.find((folder) => existsSync(folder))

export function createStoreWatch(): { watch: NonNullable<DevicesDeps['watchStore']>; changed(path: string): void } {
  const registrations = new Set<Registration>()
  return {
    watch(folders, changed) {
      const registration: Registration = { folders, changed, held: folders.every(hostPath) ? nearest(folders) : undefined }
      registrations.add(registration)
      return () => { registrations.delete(registration) }
    },
    changed(path) {
      for (const registration of [...registrations]) {
        // A registration an earlier one's caller stopped hears nothing more.
        if (!registrations.has(registration)) continue
        if (!registration.folders.every(hostPath)) {
          registration.changed()
          continue
        }
        // A folder removed ends its watch: watchNearest moves out of it.
        if (registration.held !== undefined && !existsSync(registration.held)) registration.held = nearest(registration.folders)
        if (registration.held !== dirname(path)) continue
        // As watchNearest moves to a nearer folder that appeared before it tells the change.
        registration.held = nearest(registration.folders)
        registration.changed(basename(path))
      }
    },
  }
}
