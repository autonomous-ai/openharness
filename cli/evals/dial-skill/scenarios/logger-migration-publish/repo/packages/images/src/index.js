import { log, timed } from '../../../lib/logger-v1.js'

// Scales an image down to fit a square box, never up.
export function fit(width, height, box) {
  return timed('fit', () => {
    const scale = Math.min(box / width, box / height, 1)
    const out = { width: Math.round(width * scale), height: Math.round(height * scale) }
    log.debug('fit %dx%d into %d: %dx%d', width, height, box, out.width, out.height)
    return out
  })
}
