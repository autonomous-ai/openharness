/**
 * A plan-driven fake `grid`, for specs that drive the daemon's `grid` subprocess seam.
 *
 * The real binary talks to a control plane, so the questions worth asking in a unit test are all
 * about which argv this daemon sends and what it believes about the answer. This fake answers each
 * verb from a JSON plan the test writes beside it, and appends every invocation to a log the test
 * reads back. Injected through `HARNESS_GRID_BIN`, which `gridExec.ts` prefers over the managed
 * runtime and PATH alike.
 *
 * One fake rather than one per spec: the verb-keyed plan, the `--remote` stripping and the
 * multi-turn answers are the parts that drift when copied, and a fake that means something slightly
 * different in each file is worse than none.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAKE_GRID = `#!/usr/bin/env node
const fs = require('fs')
const log = process.env.FAKE_GRID_LOG
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_GRID_PLAN, 'utf8'))
const args = process.argv.slice(2).filter((a) => a !== '--remote')
const verb = args[0] || ''
const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : []
calls.push(process.argv.slice(2))
fs.writeFileSync(log, JSON.stringify(calls))
const step = plan[verb]
if (!step) { process.exit(0) }
// A verb may answer differently on successive calls (\`ls\` before and after a create), so its
// answer can be a LIST of turns; the last turn repeats once the list runs out.
const turn = Array.isArray(step) ? (step[calls.filter((c) => c.includes(verb)).length - 1] ?? step[step.length - 1]) : step
if (turn.stdout) process.stdout.write(turn.stdout)
if (turn.stderr) process.stderr.write(turn.stderr)
process.exit(turn.exit ?? 0)
`

/** What one invocation of a verb prints and how it exits. */
export interface FakeGridTurn { stdout?: string; stderr?: string; exit?: number }

/** Keyed by the FIRST argument after `--remote` is stripped — `mcp` for `grid mcp config …`. */
export type FakeGridPlan = Record<string, FakeGridTurn | FakeGridTurn[]>

export interface FakeGrid {
  /** Every argv the fake was run with, oldest first, `--remote` included. */
  calls: () => string[][]
  /** The verbs called, in order, with `--remote` stripped — `['mcp', 'info', 'ls']`. */
  verbs: () => string[]
  /** Delete the fake and unset the variables that point at it. */
  dispose: () => void
}

/**
 * Put a fake `grid` answering `plan` in front of this process, and hand back its call log.
 *
 * Sets `HARNESS_GRID_BIN` (and the fake's own plan/log variables) on `process.env`; `dispose`
 * undoes all of it, so a spec's `afterEach` has one call to make.
 */
export function installFakeGrid(plan: FakeGridPlan): FakeGrid {
  const root = mkdtempSync(join(tmpdir(), 'fake-grid-'))
  const bin = join(root, 'grid')
  writeFileSync(bin, FAKE_GRID)
  chmodSync(bin, 0o755)
  const planFile = join(root, 'plan.json')
  writeFileSync(planFile, JSON.stringify(plan))
  const log = join(root, 'calls.json')
  process.env.HARNESS_GRID_BIN = bin
  process.env.FAKE_GRID_PLAN = planFile
  process.env.FAKE_GRID_LOG = log
  const calls = (): string[][] => {
    try {
      return JSON.parse(readFileSync(log, 'utf8')) as string[][]
    } catch {
      return []
    }
  }
  return {
    calls,
    verbs: () => calls().map((argv) => argv.find((arg) => arg !== '--remote') ?? ''),
    dispose: () => {
      rmSync(root, { recursive: true, force: true })
      delete process.env.HARNESS_GRID_BIN
      delete process.env.FAKE_GRID_PLAN
      delete process.env.FAKE_GRID_LOG
    },
  }
}

/**
 * A JWT whose payload says `exp`, signed by nobody — enough for a reader that decodes the middle
 * segment offline, which is all the daemon does with the token `grid mcp config` prints.
 */
export function fakeJwt(claims: Record<string, unknown>): string {
  const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${segment({ alg: 'none', typ: 'JWT' })}.${segment(claims)}.signature`
}

/** One signed-in account's grid, as the real `grid` would describe it — values read off a live
 *  control plane, shared so the specs that resolve a retarget all mean the same grid. */
export interface FakeGridAnswers {
  gridName: string
  networkId: string
  /** The relay root, as `grid info --env` prints `OPENAI_BASE_URL`. */
  baseUrl: string
  /** The control plane's web-tools mount, trailing slash and all. */
  mcpUrl: string
  /** The per-grid access token — the inference key AND the MCP bearer. */
  token: string
  /** The plan answering `info --env`, `mcp config --json` and `ls --json` for this grid. */
  plan: FakeGridPlan
}

const DAY_S = 24 * 60 * 60

/**
 * The answers for a grid whose token expires `expiresInDays` from now (300 by default — well
 * outside the daemon's 30-day renewal margin, so a spec that wants the cached path gets it).
 */
export function fakeGridAnswers(expiresInDays = 300): FakeGridAnswers {
  const gridName = 'someone-7f3a91c4'
  const networkId = 'grid-3378218621364f16'
  const baseUrl = `https://grid.autonomous.ai/${networkId}/relay/v1`
  const mcpUrl = 'https://api-grid.autonomous.ai/v1/grid/web-mcp/'
  const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) + expiresInDays * DAY_S, sub: 'someone' })
  return {
    gridName,
    networkId,
    baseUrl,
    mcpUrl,
    token,
    plan: {
      info: { stdout: `export OPENAI_BASE_URL="${baseUrl}"\nexport OPENAI_API_KEY="${token}"\n` },
      mcp: { stdout: JSON.stringify({ server: 'grid-web', url: mcpUrl, authorization: `Bearer ${token}` }, null, 2) },
      ls: { stdout: JSON.stringify([{ grid: gridName, id: networkId, type: 'permissioned-public' }]) },
    },
  }
}
