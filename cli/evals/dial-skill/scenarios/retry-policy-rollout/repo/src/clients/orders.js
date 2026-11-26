import { request as http } from '../http.js'

export function createOrdersClient(request = http) {
  async function get(path) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request('GET', path)
      } catch (error) {
        const transient = error.status === undefined || error.status >= 500
        if (!transient || attempt === 4) throw error
        // Jitter, so the shop's many workers do not all come back at the same moment after an outage.
        const backoff = 20 * 2 ** attempt
        await new Promise((resolve) => setTimeout(resolve, backoff + Math.random() * backoff))
      }
    }
  }

  return {
    getOrder: (id) => get(`/orders/${id}`),
    listOrders: (customerId) => get(`/customers/${customerId}/orders`).then((page) => page.items),
  }
}
