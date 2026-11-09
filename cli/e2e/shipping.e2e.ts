/**
 * The Swarm leaderboard's daemon half, end to end (docs/plans/2026-11-09-swarm-v4-leaderboard.md): a real daemon signed in to a
 * fake backend, whose gh is a script that answers GitHub's GraphQL as a repository with one issue shipped by Atlas would. The
 * daemon asks the backend what to read, reads with that gh, and reports counts only.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { until, type IsolatedDaemon } from './harness/daemon.js'
import { FakeBackend } from './harness/fakeBackend.js'
import { signedInDaemon } from './harness/fleet.js'

let relay: FakeBackend | undefined, daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
afterEach(async () => {
  client?.close(); client = undefined
  await daemon?.close().catch(() => {}); daemon = undefined
  await relay?.close(); relay = undefined
})

const DAY = 86_400_000, WEEK = 7 * DAY
const weekStart = (ms: number) => Math.floor((ms - 4 * DAY) / WEEK) * WEEK + 4 * DAY

/** A gh that answers `gh api graphql` for acme/web, whose Atlas closed one P1 issue just now with a pull request of its person's own
 *  (login ann), unless `mode` says gh is signed out. Anything else is refused, as the developer's own gh is. */
const fakeGh = (mode: 'ok' | 'signed-out') => `#!/bin/sh
case "$*" in
  *"api graphql"*) ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
${mode === 'signed-out' ? 'echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4' : ''}
query="$*"
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
case "$query" in
  *nameWithOwner*) echo '{"data":{"repository":{"nameWithOwner":"acme/web"}}}' ;;
  *closedByPullRequestsReferences*)
    case "$query" in
      *'builder:atlas'*) echo '{"data":{"viewer":{"login":"ann"},"search":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"closedAt":"'$now'","stateReason":"COMPLETED","labels":{"nodes":[{"name":"builder:atlas"},{"name":"P1"}]},"closedByPullRequestsReferences":{"nodes":[{"number":7,"title":"A secret title","merged":true,"mergedAt":"'$now'","author":{"login":"ann"}}]}}]}}}' ;;
      *) echo '{"data":{"viewer":{"login":"ann"},"search":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}' ;;
    esac ;;
  *) echo '{"data":{"search":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}' ;;
esac
`

async function run(mode: 'ok' | 'signed-out') {
  const backend = await FakeBackend.start(); relay = backend
  const spec = { machineId: 'e1'.repeat(16), computerId: 'shipping-fixture', name: 'Ann\'s Mac', token: 'fixture-ann-token', account: 'ann', email: 'ann@example.com' }
  backend.addMachine(spec)
  // `ghRun` refuses to run a real gh under a test runner (lib/github.ts): this daemon runs the gh this test writes, so it is not told it is
  // in one. The developer's own gh is never found by a daemon (the harness stubs it); this test replaces the stub.
  const d = await signedInDaemon(backend, spec, { VITEST: '' }); daemon = d
  writeFileSync(join(d.root, 'bin', 'gh'), fakeGh(mode), { mode: 0o755 })
  const from = weekStart(Date.now()) - 4 * WEEK
  const reports: Array<Record<string, any>> = []
  backend.superTabs = async (method, path, body) => {
    const url = new URL(path, 'http://fixture')
    if (url.pathname === `/api/super-tabs/hosts/${spec.machineId}/shipping`) {
      if (method === 'GET') return { data: { swarms: [{ tabId: 'tab-1', repositories: ['acme/web'], agents: [{ id: 'atlas', name: 'Atlas', from }] }] } }
      reports.push(body)
      return { data: { applied: 1, skipped: 0, capped: 0 } }
    }
    // The host the wake starts reads its Swarms each second: it has none.
    if (url.pathname === `/api/super-tabs/hosts/${spec.machineId}/changes`) return { data: { format: 2, full: true, cursor: 'fixture', tabs: [], removedTabIds: [] } }
    return { status: 404, error: { code: 'NOT_FOUND', message: path } }
  }
  onTestFailed(() => console.log(d.log().split('\n').slice(-60).join('\n')))
  await d.start()
  await until('the fixture account connected', () => backend.nodeUp(spec.machineId), 30000)
  client = await LocalClient.connect(d, { machineId: spec.machineId })
  expect(await client.request('super_tabs', { action: 'wake' }, 30000)).toMatchObject({ ok: true })
  // The first look is 10 to 20 seconds after the host starts.
  await until('the daemon reports', () => reports.length > 0, 90000, 500)
  return { reports, from, log: () => d.log() }
}

it('reads GitHub with its own gh and reports what the agent shipped, as counts and nothing else', async () => {
  const { reports, from, log } = await run('ok')
  expect(reports[0]).toEqual({ tabId: 'tab-1', agents: [{ agentId: 'atlas', name: 'Atlas', from, weeks: [{ week: weekStart(Date.now()), P1: 1 }] }] })
  // Nothing of the issue or its pull request left this computer: not its title, a label, a number.
  expect(JSON.stringify(reports)).not.toMatch(/secret|builder|acme|"7"|#7/i)
  expect(log()).toMatch(/\[shipping\] read swarms=1 issues=1 ms=\d+/)
}, 180000)

it('reports why when gh cannot read, which the board shows to its person, and says it once in the log', async () => {
  const { reports, log } = await run('signed-out')
  expect(reports[0]).toEqual({ tabId: 'tab-1', agents: [{ agentId: 'atlas', failed: 'GH_SIGNED_OUT' }] })
  expect(log().match(/\[shipping\] could not read GitHub: GH_SIGNED_OUT/g)).toHaveLength(1)
}, 180000)
