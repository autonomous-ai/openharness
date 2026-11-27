import { request as http } from '../http.js'

// The geocoder sheds load with 503 and nothing else, so only a 503 is tried again, after each of these pauses.
const PAUSES_MS = [25, 50, 100]

export function createGeocodingClient(request = http) {
  return {
    async lookup(address) {
      const path = `/geocode?q=${encodeURIComponent(address)}`
      for (const pause of PAUSES_MS) {
        try {
          return await request('GET', path)
        } catch (error) {
          if (error.status !== 503) throw error
          await new Promise((resolve) => setTimeout(resolve, pause))
        }
      }
      return request('GET', path)
    },
  }
}
