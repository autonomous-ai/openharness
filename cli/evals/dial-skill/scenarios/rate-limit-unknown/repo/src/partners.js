import { readFileSync } from 'node:fs'

// Reads the two-level `partners:` map of config/partners.yml; the file holds nothing deeper.
export function loadPartners(path = new URL('../config/partners.yml', import.meta.url)) {
  const partners = {}
  let current = null
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.replace(/\s+#.*$/, '')
    const partner = line.match(/^ {2}([a-z0-9-]+):\s*$/)
    const field = line.match(/^ {4}([a-z_]+):\s*(.+?)\s*$/)
    if (partner) partners[(current = partner[1])] = {}
    else if (field && current) partners[current][field[1]] = /^\d+$/.test(field[2]) ? Number(field[2]) : field[2]
  }
  return partners
}

export function validate(partners) {
  const problems = []
  for (const [name, p] of Object.entries(partners)) {
    if (!Number.isInteger(p.rate_limit) || p.rate_limit <= 0) {
      problems.push(`${name}.rate_limit must be a number (got ${p.rate_limit})`)
    }
    if (!p.webhook_secret) problems.push(`${name}.webhook_secret is missing`)
  }
  return problems
}
