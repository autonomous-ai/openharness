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

  async function charge(customerId, amountCents, currency) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await request('POST', '/charges', { customerId, amountCents, currency })
      } catch (error) {
        if (attempt === 3 || error.cause?.code !== 'ECONNREFUSED') throw error
        await sleep(100)
      }
    }
  }

  return {
    getCharge: (id) => read(`/charges/${id}`),
    listRefunds: (chargeId) => read(`/charges/${chargeId}/refunds`).then((page) => page.items),
    charge,
  }
}
