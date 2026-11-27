import { titleCase, truncate } from '../utils.js'
import { PRODUCTS } from './catalog.js'

export function searchProducts(query) {
  const q = query.trim().toLowerCase()
  return PRODUCTS.filter((product) => product.name.toLowerCase().includes(q)).map((product) =>
    truncate(titleCase(product.name), 10),
  )
}
