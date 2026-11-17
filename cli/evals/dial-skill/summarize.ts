// npx tsx evals/dial-skill/summarize.ts <flow>: writes each variant's table.md, the status table in narrative.md and
// the aggregate table in metrics.md, and prints the headline.
import { writeSummaries } from './lib/summarize.js'

const flow = process.argv[2]
if (!flow || process.argv.length > 3) {
  console.error('usage: npx tsx evals/dial-skill/summarize.ts <flow>')
  process.exit(2)
}
console.log(writeSummaries(flow))
