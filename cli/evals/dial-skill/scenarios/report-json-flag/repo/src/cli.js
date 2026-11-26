import { buildReport, renderReport } from './report.js'

const USAGE = 'usage: node src/cli.js report [--region <name>]'

function fail(message) {
  console.error(`${message}\n${USAGE}`)
  process.exit(2)
}

function report(args) {
  const options = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--region' && args[i + 1] !== undefined) options.region = args[++i]
    else fail(`report: unknown option ${args[i]}`)
  }
  console.log(renderReport(buildReport(options)))
}

const [command, ...args] = process.argv.slice(2)
if (command === 'report') report(args)
else fail(command === undefined ? 'missing command' : `unknown command ${command}`)
