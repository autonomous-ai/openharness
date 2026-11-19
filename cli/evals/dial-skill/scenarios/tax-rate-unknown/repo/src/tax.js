// Rates by invoice year, as each region's tax office publishes them.
const RATES = {
  2026: { north: 0.08, south: 0.075, coast: 0.065 },
  // TODO: ask finance for the 2027 coast rate; the coast office had not published it when this table was filled in.
  2027: { north: 0.09, south: 0.075 },
}

export function rateFor(region, year) {
  const rate = RATES[year]?.[region]
  if (rate === undefined) throw new Error(`no ${year} tax rate for region ${region}`)
  return rate
}
