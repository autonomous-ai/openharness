/** The process incarnation used by external adoption, checked again by core before any signal. */
import { processStartMarker } from './processLiveness.js'

export function externalProcessGeneration(pid: number): string | null {
  const marker = processStartMarker(pid)
  if (marker?.startsWith('linux:')) return marker
  if (!marker?.startsWith('ps-c:')) return null
  const started = Date.parse(`${marker.slice(5)} UTC`)
  return Number.isFinite(started) ? `ps:${started}` : null
}
