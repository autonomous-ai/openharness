// Dry run: node --import tsx scripts/memory-extraction-eval.ts
// Add --batch for the frozen multi-episode suite. Native run: --run-native --output <report.json>.
// Recall uses source excerpts by default; --recall-format summary selects the older comparison arm.
// At most six calls, no retries/fallback.
// Synthetic data only. Reads selected companion metadata; never writes the production memory DB.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { memoryAccountIdentity } from '../src/memory/account.js'
import { claudeMemoryCapability, runClaudeMemoryInference } from '../src/memory/claudeInference.js'
import { codexMemoryCapability, runCodexMemoryInference } from '../src/memory/inference.js'
import { evaluateExtractionCase, type ExtractionScenario } from '../src/memory/evaluation.js'
import { EXTRACTION_PROMPT_VERSION } from '../src/memory/learner.js'
import { MEMORY_CONTEXT_VERSION } from '../src/memory/context.js'
import type { MemoryInferenceObservation, MemoryInferenceOptions } from '../src/memory/inferenceProcess.js'
import { MemoryError, type RecallRequest } from '../src/memory/types.js'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('..', import.meta.url))
const root = dirname(cli)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const args = process.argv.slice(2)
const options = new Map<string, string | true>()
for (let index = 0; index < args.length; index++) {
  const key = args[index]
  if (options.has(key)) throw new Error('Duplicate diagnostic option')
  if (['--batch', '--run-native'].includes(key)) options.set(key, true)
  else if (['--output', '--recall-format'].includes(key) && args[index + 1] && !args[index + 1].startsWith('--')) {
    options.set(key, args[++index])
  } else throw new Error('Use --batch, --run-native --output <report.json>, and/or --recall-format source_excerpts|summary')
}
const recallFormat = options.get('--recall-format') ?? 'source_excerpts'
if (recallFormat !== 'summary' && recallFormat !== 'source_excerpts') throw new MemoryError('invalid_evaluation_recall_format')
const batch = options.has('--batch')
const suitePath = join(root, batch ? 'docs/research/2026-09-30-memory-batch-extraction-cases.json' : 'docs/research/2026-09-30-memory-extraction-cases.json')
const native = options.has('--run-native')
const output = options.has('--output') ? resolve(options.get('--output') as string) : null
if (native && !output) throw new Error('Use --run-native --output <report.json>')
const suiteText = await readFile(suitePath, 'utf8')
const suite = JSON.parse(suiteText) as { suite: string; cases: ExtractionScenario[] }
if (!Array.isArray(suite.cases) || suite.cases.length > 6) throw new Error('At most six frozen cases per diagnostic run')
if (!native) {
  console.log(JSON.stringify({ suite: suite.suite, sha256: digest(suiteText), cases: suite.cases.map(row => row.id),
    recallFormat, nativeCalls: 0, status: 'not_run',
    instructions: `Use ${batch ? '--batch ' : ''}--recall-format ${recallFormat} --run-native --output <report.json> with the current companion model.` }, null, 2))
} else {
  try { await run() } catch (error) {
    console.error(JSON.stringify({ status: 'not_run', error: error instanceof MemoryError ? error.code : 'evaluation_unavailable' }))
    process.exitCode = 1
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

async function json(path: string): Promise<unknown> {
  const file = await open(path, 'r')
  try {
    if ((await file.stat()).size > 8_000_000) throw new MemoryError('metadata_too_large')
    return JSON.parse(await file.readFile('utf8'))
  } finally { await file.close() }
}

async function selection() {
  const { stdout } = await exec(process.execPath, [join(cli, 'dist/cli.js'), 'pair', 'lessons', 'list', '--json'],
    { timeout: 10_000, maxBuffer: 1_000_000 })
  // Discard the other legacy response fields immediately; never save or print lesson content.
  const result = object(JSON.parse(stdout)), learning = object(result.learning)
  if (!result.ok || learning.state !== 'ready' || !['claude', 'codex'].includes(String(learning.engine))
    || typeof learning.agentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(learning.agentId) || typeof learning.model !== 'string'
    || !['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'].includes(String(learning.effort))) throw new MemoryError('companion_not_ready')
  const data = process.env.ADAPTER_DATA_DIR || join(homedir(), '.harness/cli/data')
  const registry = await json(join(data, 'registry.json'))
  if (!Array.isArray(registry)) throw new MemoryError('unsupported_registry')
  const live = registry.find(row => object(row).agentId === learning.agentId)
  const session = object(live ?? object(await json(join(data, 'stopped-agents', `${learning.agentId}.json`))).session)
  if (session.agentId !== learning.agentId || session.engine !== learning.engine || typeof session.sessionId !== 'string' || !session.sessionId
    || session.dsh !== 'autonomous/pair' || session.grid || session.gridLaunch || session.gateway) throw new MemoryError('unsupported_companion_binding')
  const codexHome = typeof session.codexHome === 'string' ? session.codexHome : undefined
  const account = await memoryAccountIdentity({ engine: String(learning.engine), codexHome })
  if (!account) throw new MemoryError('native_account_unavailable')
  const capability = await (learning.engine === 'claude' ? claudeMemoryCapability() : codexMemoryCapability())
  if (!capability.supported) throw new MemoryError('native_version_uncertified')
  return { engine: learning.engine as 'claude' | 'codex', model: learning.model as string,
    effort: learning.effort as 'auto' | NonNullable<MemoryInferenceOptions['effort']>, codexHome,
    nativeVersion: capability.version,
    key: digest(JSON.stringify([learning.agentId, session.sessionId, learning.engine, learning.model, learning.effort,
      learning.contextKey ?? null, session.codexHome ?? null, account, capability.version])) }
}

async function run() {
  const selected = await selection()
  await mkdir(dirname(output!), { recursive: true })
  // A diagnostic rerun must use a new path; preserve the evidence from earlier attempts.
  try { await (await open(output!, 'wx', 0o600)).close() } catch { throw new MemoryError('evaluation_report_unavailable_or_exists') }
  const temporary = await mkdtemp(join(tmpdir(), 'memory-extraction-eval-'))
  const sourceFiles = ['learner.ts', 'context.ts', 'types.ts', 'admission.ts', 'store.ts', 'recallSources.ts', 'queue.ts', 'evaluation.ts',
    'account.ts', 'claudeInference.ts', 'inference.ts', 'inferenceProcess.ts']
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, digest(await readFile(join(cli, 'src/memory', name), 'utf8'))])))
  const report: Record<string, any> = { schemaVersion: 1, suite: suite.suite, suiteSha256: digest(suiteText),
    promptVersion: EXTRACTION_PROMPT_VERSION, contextVersion: MEMORY_CONTEXT_VERSION, recallFormat,
    runnerSha256: digest(await readFile(fileURLToPath(import.meta.url), 'utf8')),
    sourceHashes, startedAt: new Date().toISOString(), status: 'running',
    selected: { engine: selected.engine, model: selected.model, effort: selected.effort, nativeVersion: selected.nativeVersion },
    limits: { maxCalls: 6, timeoutPerCallMs: 90_000, retries: 0, corpus: 'synthetic_only', tools: 'restricted_native_adapter' },
    limitations: ['Development diagnostics, not held-out release evidence.',
      'Mechanical checks do not establish faithful meaning or downstream task usefulness.',
      'Recall probe passes measure presence only; correct-memory recall requires a separately attributed semantic review.',
      'Semantic review remains pending until explicitly reviewed.',
      'A native init model label does not prove that the provider executed that model.',
      'Native-reported cost is diagnostic metadata, not a subscription invoice.',
      'No personal transcript was supplied to inference; live reads establish selected companion metadata only.'],
    cases: [], nativeCalls: 0 }
  const save = async () => {
    await mkdir(dirname(output!), { recursive: true })
    await writeFile(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    await rename(`${output}.tmp`, output!)
  }
  try {
    await save()
    for (const fixture of suite.cases) {
      const observations: MemoryInferenceObservation[] = []
      let promptSha256: string | null = null
      const result = await evaluateExtractionCase({ fixture, directory: join(temporary, fixture.id), engine: selected.engine,
        recallFormat: recallFormat as RecallRequest['format'],
        inference: {
          target: async () => {
            const current = await selection()
            return { state: current.key === selected.key ? 'ready' : 'waiting', key: current.key }
          },
          run: async (prompt, options) => {
            if (report.nativeCalls >= 6 || (await selection()).key !== selected.key) throw new MemoryError('evaluation_selection_changed')
            promptSha256 = digest(prompt)
            report.nativeCalls++
            const runNative = selected.engine === 'claude' ? runClaudeMemoryInference : runCodexMemoryInference
            const cwd = join(temporary, 'native-work')
            await mkdir(cwd, { recursive: true, mode: 0o700 })
            const answer = await runNative({ ...options, prompt, cwd, model: selected.model,
              ...(selected.effort === 'auto' ? {} : { effort: selected.effort }), codexHome: selected.codexHome,
              beforeRun: async () => {
                if ((await selection()).key !== options.contextKey) throw new MemoryError('evaluation_selection_changed')
              },
              observe: observation => { observations.push(observation) } })
            if ((await selection()).key !== selected.key) throw new MemoryError('evaluation_selection_changed')
            return answer.text
          },
        } })
      report.cases.push({ ...result, promptSha256, observations })
      await save()
      console.log(JSON.stringify({ id: result.id, outcome: result.outcome, durationMs: result.durationMs,
        failedChecks: result.checks.filter(check => check.passed === false).map(check => check.name) }))
      if (['waiting_for_model', 'budget_deferred', 'stale'].includes(result.outcome.state)
        || result.outcome.reason === 'evaluation_selection_changed') break
    }
    report.status = report.cases.length === suite.cases.length ? 'completed' : 'stopped'
    if (report.status !== 'completed') process.exitCode = 2
    else if (report.cases.some((row: { checks: Array<{ passed: boolean | null }> }) => row.checks.some(check => check.passed !== true))) process.exitCode = 1
  } catch (error) {
    report.status = 'stopped'
    // Native errors can carry credentials, source text or stderr; report only our bounded code.
    report.error = error instanceof MemoryError ? error.code : 'evaluation_unavailable'
    process.exitCode = 1
  } finally {
    report.finishedAt = new Date().toISOString()
    report.completedCases = report.cases.filter((row: any) => row.checks[0].passed).length
    try { await save() } finally { await rm(temporary, { recursive: true, force: true }) }
  }
}
