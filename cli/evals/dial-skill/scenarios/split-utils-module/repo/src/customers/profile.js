import { titleCase } from '../utils.js'

export function displayName(customer) {
  return titleCase(`${customer.first} ${customer.last}`)
}
