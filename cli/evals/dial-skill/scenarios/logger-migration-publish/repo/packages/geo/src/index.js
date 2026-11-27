import { log, timed } from '../../../lib/logger-v1.js'

const EARTH_KM = 6371
const rad = (deg) => (deg * Math.PI) / 180

// Great-circle distance between two { lat, lon } points, in kilometres.
export function distanceKm(a, b) {
  for (const point of [a, b]) {
    if (Math.abs(point.lat) > 90) {
      log.warn(`latitude ${point.lat} out of range`)
      return NaN
    }
  }
  return timed('distance', () => {
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
      + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2
    return 2 * EARTH_KM * Math.asin(Math.sqrt(h))
  })
}
