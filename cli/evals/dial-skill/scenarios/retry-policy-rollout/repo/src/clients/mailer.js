import { request as http } from '../http.js'

export function createMailerClient(request = http) {
  return {
    async send({ to, subject, text }) {
      let tries = 0
      while (true) {
        try {
          return await request('POST', '/mail', { to, subject, text })
        } catch (error) {
          // Only 429: the mail service rate-limits bursts, and any other error is a message it will not take.
          tries += 1
          if (error.status !== 429 || tries === 5) throw error
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
    },
  }
}
