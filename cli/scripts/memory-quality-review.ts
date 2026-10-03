// Offline only: --suite frozen.json --report native-report.json --output new-packet.json
// Fill a separate copy of packet.review, then add --review labels.json to write attributed scores.
import { open, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareEvaluationReview, scoreEvaluationReview } from '../src/memory/evaluationReview.js'
import { MemoryError } from '../src/memory/types.js'

async function read(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    if ((await file.stat()).size > 8_000_000) throw new MemoryError('evaluation_file_too_large')
    return await file.readFile('utf8')
  } finally { await file.close() }
}

try {
  const args = process.argv.slice(2), files = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1]
    if (!['--suite', '--report', '--review', '--output'].includes(key) || files.has(key) || !value || value.startsWith('--')) {
      throw new MemoryError('use_suite_report_output_and_optional_review')
    }
    files.set(key, resolve(value))
  }
  if (!['--suite', '--report', '--output'].every(key => files.has(key))) throw new MemoryError('use_suite_report_output_and_optional_review')
  const [suite, report] = await Promise.all([read(files.get('--suite')!), read(files.get('--report')!)])
  const result = files.has('--review') ? scoreEvaluationReview(suite, report, await read(files.get('--review')!))
    : prepareEvaluationReview(suite, report)
  const hash = async (url: URL) => createHash('sha256').update(await read(fileURLToPath(url))).digest('hex')
  const producer = { protocol: 'coding-memory-quality-review-v2', node: process.version,
    runnerSha256: await hash(new URL(import.meta.url)),
    scorerSha256: await hash(new URL('../src/memory/evaluationReview.ts', import.meta.url)),
    contextValidatorSha256: await hash(new URL('../src/memory/evaluationContext.ts', import.meta.url)) }
  // Never overwrite an earlier result or print source conversations to the terminal.
  await writeFile(files.get('--output')!, `${JSON.stringify({ ...result, producer }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify({ status: 'written', kind: files.has('--review') ? 'review_scores' : 'review_packet',
    cases: result.cases.length, nativeCalls: 0 }))
} catch (error) {
  console.error(JSON.stringify({ status: 'not_written', error: error instanceof MemoryError ? error.code : 'evaluation_file_unavailable' }))
  process.exitCode = 1
}
