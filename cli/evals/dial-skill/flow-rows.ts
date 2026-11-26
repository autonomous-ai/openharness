// npx tsx evals/dial-skill/flow-rows.ts scrub <flow>: rewrites every variant's results, errors and probes rows fit to
// commit, then checks them; exit 1 lists what is left.
// npx tsx evals/dial-skill/flow-rows.ts supersede <flow> <variant> <scenario>: moves a scenario's rows to errors.jsonl,
// so the runner runs its cases again; exit 1 when it has none.
import { homedir, hostname, userInfo } from 'node:os'
import { scrubFlow, supersedeFlow } from './lib/flow-rows.js'

const [command, flow, ...rest] = process.argv.slice(2)
try {
  if (command === 'scrub' && flow && rest.length === 0) {
    const { read, faults } = scrubFlow(flow, { home: homedir(), user: userInfo().username, host: hostname() })
    for (const fault of faults) console.error(fault)
    if (faults.length) process.exit(1)
    for (const line of read) console.log(line)
  } else if (command === 'supersede' && flow && rest.length === 2) {
    const [variant, scenario] = rest
    const moved = supersedeFlow(flow, variant, scenario)
    if (!moved) {
      console.error(`no rows of ${scenario} in ${variant}/results.jsonl`)
      process.exit(1)
    }
    console.log(`${moved} moved to ${variant}/errors.jsonl as superseded`)
  } else {
    console.error('usage: npx tsx evals/dial-skill/flow-rows.ts scrub <flow> | supersede <flow> <variant> <scenario>')
    process.exit(2)
  }
} catch (error) {
  console.error((error as Error).message)
  process.exit(2)
}
