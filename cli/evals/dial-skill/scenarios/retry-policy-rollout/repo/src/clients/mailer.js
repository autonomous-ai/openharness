import { randomUUID } from 'node:crypto'
import { request as http } from '../http.js'

export function createMailerClient(request = http) {
  return {
    async send({ to, subject, text }) {
      // The mail service drops a message whose key it has already taken, so every try carries the same one.
      const headers = { 'Idempotency-Key': randomUUID() }
      let tries = 0
      while (true) {
        try {
          return await request('POST', '/mail', { to, subject, text }, headers)
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
