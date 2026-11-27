// Amounts are in cents; tax and discounts leave fractions of a cent.
export function roundCents(amount) {
  return Math.floor(amount)
}

export function invoiceTotal(lines, taxRate) {
  const net = lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0)
  return net + roundCents(net * taxRate)
}
