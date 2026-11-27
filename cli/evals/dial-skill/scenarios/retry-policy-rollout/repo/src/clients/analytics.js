import { request as http } from '../http.js'

export function createAnalyticsClient(request = http) {
  return {
    async getReport(name, { from, to }) {
      const path = `/reports/${encodeURIComponent(name)}?from=${from}&to=${to}`
      let tries = 0
      while (true) {
        try {
          return await request('GET', path)
        } catch (error) {
          // The reporting service answers 404 for a while after a nightly rebuild, so every error is worth a try.
          tries += 1
          if (tries === 4) throw error
          await new Promise((resolve) => setTimeout(resolve, 30 * tries))
        }
      }
    },
  }
}
