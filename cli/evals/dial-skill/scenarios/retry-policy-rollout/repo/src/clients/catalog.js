import { request as http } from '../http.js'

export function createCatalogClient(request = http) {
  async function get(path, attempt = 1) {
    try {
      return await request('GET', path)
    } catch (error) {
      if (attempt === 3 || error.status === 404) throw error
      await new Promise((resolve) => setTimeout(resolve, 40 * attempt))
      return get(path, attempt + 1)
    }
  }

  return {
    getProduct: (sku) => get(`/products/${encodeURIComponent(sku)}`),
    search: (query) => get(`/products?q=${encodeURIComponent(query)}`).then((page) => page.items),
  }
}
