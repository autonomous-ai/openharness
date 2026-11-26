import { request as http } from '../http.js'

export function createInventoryClient(request = http) {
  async function get(path) {
    let attempt = 0
    let result
    do {
      attempt++
      try {
        result = { ok: true, value: await request('GET', path) }
      } catch (error) {
        result = { ok: false, error }
        if (error.status !== undefined && error.status < 500) break
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 40))
      }
    } while (!result.ok && attempt < 3)
    if (!result.ok) throw result.error
    return result.value
  }

  return {
    stockOf: (sku) => get(`/inventory/${encodeURIComponent(sku)}`).then((row) => row.available),
    warehouses: () => get('/warehouses'),
  }
}
