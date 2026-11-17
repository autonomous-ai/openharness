// npx tsx evals/dial-skill/summarize.ts <flow>: writes each variant's table.md, the status table in narrative.md and
// the aggregate table in metrics.md, and prints the headline.
import { writeSummaries } from './lib/summarize.js'

// $ per million tokens, from the claude-api skill's Current Models table (cached 2026-11-03).
const PRICES = {
  'claude-opus-5-5': { in: 4, out: 20 },
}

const flow = process.argv[2]
if (!flow || process.argv.length > 3) {
  console.error('usage: npx tsx evals/dial-skill/summarize.ts <flow>')
  process.exit(2)
}
console.log(writeSummaries(flow, PRICES))
