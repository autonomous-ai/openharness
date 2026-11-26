import { formatCents, slugify } from '../utils.js'

export const PRODUCTS = [
  { name: 'Café Mug', cents: 1450 },
  { name: 'Linen Apron', cents: 3200 },
  { name: 'Walnut Board', cents: 5899 },
]

export function catalogEntries() {
  return PRODUCTS.map((product) => ({ slug: slugify(product.name), price: formatCents(product.cents) }))
}
