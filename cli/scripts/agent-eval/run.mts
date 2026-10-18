// Runs Claude Code or Codex on the cases, one fresh session each, saves the transcripts, and scores them (README.md).
// usage (from cli/): npx tsx scripts/agent-eval/run.mts --agent claude|codex --machine NAME --offline NAME --out DIR [--only id,id] [--yes]
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { callsFromClaude, callsFromCodex, evalEnv, score, type Case, type Score } from './score.mts'

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? undefined : process.argv[i + 1] }
const agent = arg('agent'), machine = arg('machine'), offline = arg('offline'), out = arg('out')
if ((agent !== 'claude' && agent !== 'codex') || !machine || !offline || !out) {
  console.error('usage: npx tsx scripts/agent-eval/run.mts --agent claude|codex --machine NAME --offline NAME --out DIR [--only id,id] [--yes]')
  process.exit(2)
}
const only = arg('only')?.split(',')
const repo = resolve(import.meta.dirname, '..', '..', '..')
const fill = (text: string) => text.replaceAll('{machine}', machine).replaceAll('{offline}', offline)
const cases = (JSON.parse(readFileSync(join(import.meta.dirname, 'cases.json'), 'utf8')) as Case[]).filter((c) => !only || only.includes(c.id))

// The cold start: the agent is told only that the CLI is there.
const prompt = (c: Case) => `${fill(c.prompt)}\n\nThe \`harness\` command is installed on this computer.`

if (!process.argv.includes('--yes')) {
  console.log(`Would run ${agent} on ${cases.length} cases in ${repo}. Each may start real harnesses and spend tokens.`)
  for (const c of cases) console.log(`- ${c.id}: setup: ${fill(c.setup)}`)
  console.log('Run again with --yes once the person has approved.')
  process.exit(0)
}

function runAgent(c: Case): Promise<string[]> {
  const [cmd, args] = agent === 'claude'
    ? ['claude', ['-p', prompt(c), '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Bash(harness:*)', 'Read', '--disallowedTools', 'Edit', 'Write']]
    : ['codex', ['exec', '--json', '-C', repo, prompt(c)]]
  return new Promise((done) => {
    const child = spawn(cmd, args as string[], { cwd: repo, env: evalEnv(process.env), stdio: ['ignore', 'pipe', 'inherit'] })
    let text = ''
    child.stdout.on('data', (chunk) => { text += chunk })
    child.on('close', () => done(text.split('\n').filter(Boolean)))
  })
}

mkdirSync(out, { recursive: true })
const ask = createInterface({ input: process.stdin, output: process.stdout })
const scores: Score[] = []
for (const c of cases) {
  await ask.question(`\n[${c.id}] Set up: ${fill(c.setup)}\nPress Enter when it is set up. `)
  const lines = await runAgent(c)
  writeFileSync(join(out, `${agent}-${c.id}.jsonl`), `${lines.join('\n')}\n`)
  const { calls, answer } = agent === 'claude' ? callsFromClaude(lines) : callsFromCodex(lines)
  const s = score(c, agent, calls, answer)
  scores.push(s)
  console.log(JSON.stringify(s))
  if (s.leftOpen) console.log(`It left ${s.leftOpen} open: close them (harness ps) before the next case.`)
}
ask.close()
writeFileSync(join(out, `${agent}-scores.json`), `${JSON.stringify(scores, null, 1)}\n`)
const sum = (k: keyof Score) => scores.reduce((n, s) => n + Number(s[k]), 0)
console.log(`\n${agent}: done ${sum('done')}/${scores.length} · orientation calls ${sum('orientation')} · wrong ${sum('wrong')} · retries after refusal ${sum('retriesAfterRefusal')} · left open ${sum('leftOpen')}`)
