/** Run: backend/node_modules/.bin/tsx scripts/check-pr-history.ts < history.json
 * JSON facts only; never checks out, imports or runs the pull request's code. */
import { checkPrHistory } from '../backend/src/superTabs/prHistory.js'

async function main() {
  let size = 0
  const chunks: Buffer[] = []
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > 4 * 1024 * 1024) throw new Error('input too large')
      chunks.push(bytes)
    }
    const result = checkPrHistory(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.commits === null) process.exitCode = 1
  } catch {
    process.stderr.write('PR history input is invalid or exceeds 4 MiB.\n')
    process.exitCode = 1
  }
}
void main()
