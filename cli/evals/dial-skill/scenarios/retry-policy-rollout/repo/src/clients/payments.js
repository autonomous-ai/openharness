import { request as http } from '../http.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createPaymentsClient(request = http) {
  async function read(path) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await request('GET', path)
      } catch (error) {
        if (attempt === 3 || (error.status !== undefined && error.status < 500)) throw error
        await sleep(50 * attempt)
      }
    }
  }

  return {
    getCharge: (id) => read(`/charges/${id}`),
    listRefunds: (chargeId) => read(`/charges/${chargeId}/refunds`).then((page) => page.items),
    // Sent once, unlike the reads. The provider's v2 API takes no idempotency key, so when a charge times out after
    // the provider took it, a second try charges the card twice. Whether charges are retried, and how, is open in
    // issues/57-charge-retries.md.
    charge: (customerId, amountCents, currency) => request('POST', '/charges', { customerId, amountCents, currency }),
  }
}
