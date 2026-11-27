/**
 * Tier B of the dial eval's held-out set (docs/plans/2026-11-21-dial-app-eval-design.md, "Held-out set"): whoever fixes a
 * failing group of the dial eval does not read this file. Each held-out scenario of the catalog that runs in tier B, on
 * the real daemon and devices process, through the tier B driver (harness/appEvalDriver.ts) and its app's steps. Scored
 * and reported apart, never in the headline score.
 *
 * The editors' held-out scenarios (docs/plans/2026-11-22-dial-eval-vscode-cursor-design.md, "Held-out set") run on the
 * editors' steps (harness/appEvalEditor.ts), as their main ones do, and Orca's
 * (docs/plans/2026-11-22-dial-eval-orca-design.md, "Held-out set") on Orca's (harness/appEvalOrca.ts), and iTerm2's
 * (docs/plans/2026-11-22-dial-eval-iterm2-design.md, "Held-out set") on iTerm2's (harness/appEvalIterm.ts), macOS only.
 *
 * macOS and Linux. Every daemon has a throwaway home; its open, its home, the apps' stores and VS Code's, Cursor's and
 * Orca's CLIs are checked inside its root before it starts, the harness's recording `open` (HARNESS_OPEN_BIN) and the
 * fake backend only; iTerm2's server, tmux's folder and herdr's config are checked inside it after each scenario. The
 * real Claude and ChatGPT apps, VS Code, Cursor, cursor-agent, Orca, their stores and CLIs, `/usr/bin/open`, `~/.claude`,
 * `~/.codex`, `~/.vscode`, `~/.cursor`, the person's iTerm2, tmux server and herdr, and this computer's daemon are never
 * touched. The network guard runs in this process and in every process of each daemon: a connection to anything but this
 * machine fails the scenario, by host and port.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HARNESS_OWNER_OPTION, paneOwnerFormat } from '../src/lib/harnessSessionLabel.js'
import { scenariosFor } from '../src/testing/dialAppEval/catalog.js'
import { loadBaseline, SKIP_RATCHET_ENV, tierBVerdict } from '../src/testing/dialAppEval/grade.js'
import { collect, runScenario, uncaughtProbes, writeResults, type ScenarioRun } from '../src/testing/dialAppEval/runner.js'
import { itermPlaceOf, type Platform } from '../src/testing/dialAppEval/types.js'
import { chatgptSteps } from './harness/appEvalChatgpt.js'
import { claudeSteps } from './harness/appEvalClaude.js'
import { inside, orcaCliInside, TierBDriver } from './harness/appEvalDriver.js'
import { cursorSteps, vscodeSteps } from './harness/appEvalEditor.js'
import { itermSteps } from './harness/appEvalIterm.js'
import { orcaSteps } from './harness/appEvalOrca.js'
import { herdrBinary, othersNow } from './harness/herdrServer.js'
import { gone, itermServerPath } from './harness/outsideAgent.js'

const WIN32 = process.platform === 'win32'
const HOST = process.platform as Platform
const SCENARIOS = WIN32 ? [] : scenariosFor('b', HOST).filter((s) => s.heldOut)

/** What the devices ask tmux of a pane (cable/hosts/tmux.ts TMUX_PANE_FACTS): its process, its session and both owner
 *  tags in one format, which no hook asks (hook/notify.mjs readPaneDescription asks one tag). */
const DEVICES_PANE_FACTS = `#{pane_pid}|#{session_name}|#{${HARNESS_OWNER_OPTION}}${paneOwnerFormat(false)}`

/** What a scenario's run proves beside its checks, read from its world as it stopped. */
const ALSO: Partial<Record<string, (driver: TierBDriver) => void>> = {
  // b's Codex wrote its thread in the daemon's CODEX_HOME, where the devices read its recap, and its hooks came from its
  // tmux pane: the devices asked tmux of that pane, by their own command, as the hook's tmux runs are noted too.
  IH5: (driver) => {
    const { d } = driver.lastWorld()
    const b = driver.lastWorld().session('b')
    expect(readdirSync(join(d.env.CODEX_HOME!, 'sessions'), { recursive: true }).some((name) => String(name).endsWith(`-${b.id}.jsonl`))).toBe(true)
    expect(driver.seen().commands.map((c) => c.argv)).toContainEqual(['tmux', 'display-message', '-p', '-t', 'pane:b', DEVICES_PANE_FACTS])
  },
}

describe.skipIf(WIN32)('the dial eval, tier B: the held-out set', () => {
  let driver: TierBDriver
  const runs: ScenarioRun[] = []
  beforeAll(() => { driver = new TierBDriver({ claude: claudeSteps, chatgpt: chatgptSteps, vscode: vscodeSteps, cursor: cursorSteps, orca: orcaSteps, iterm: itermSteps }) })
  afterAll(async () => {
    if (process.env.DIAL_EVAL_OUT) writeResults(process.env.DIAL_EVAL_OUT, 'heldOut', collect(runs))
    // It throws naming each attempt off this machine not asserted on yet, the last daemon's as it closed among them.
    await driver?.close()
  })

  it.for(SCENARIOS)('$id: $title', async (scenario, { skip }) => {
    // herdr's scenarios need herdr and the cc that builds its agent, as iTerm2's main file's do.
    if (!herdrBinary && scenario.app === 'iterm' && scenario.sessions.some((s) => itermPlaceOf(s) === 'herdr')) skip()
    // iTerm2's alone: macOS's process table.
    const before = scenario.app === 'iterm' ? othersNow() : []
    const began = Date.now()
    const run = await runScenario(driver, scenario, HOST)
    // Kept before any assertion, so a scenario that fails one is still in the results and the baseline's verdict.
    runs.push(run)
    expect(run.error).toBeUndefined()
    console.log(`[dial eval] ${scenario.id}: ${Date.now() - began} ms`)
    const { d } = driver.lastWorld()
    for (const path of [d.env.HOME, d.env.HARNESS_OPEN_BIN, d.env.HARNESS_VSCODE_BIN, d.env.HARNESS_CURSOR_BIN]) {
      expect(inside(d.root, path), path).toBe(true)
    }
    expect(() => orcaCliInside(d.env, d.root, process.platform)).not.toThrow()
    if (scenario.app === 'iterm') {
      for (const path of [itermServerPath(d), d.env.TMUX_TMPDIR,
        join(d.env.HOME!, '.config', 'herdr')]) {
        expect(inside(d.root, path), path).toBe(true)
      }
      // The herdrs outside this worker, the person's among them: the daemon's table kept none, and each it dropped that
      // still runs is one of them.
      const { herdrs } = driver.lastWorld()
      const others = [...before, ...othersNow()]
      expect(herdrs.kept().filter((pid) => others.includes(pid))).toEqual([])
      expect(herdrs.dropped().filter((pid) => !others.includes(pid) && !gone(pid))).toEqual([])
    }
    ALSO[scenario.id]?.(driver)
    expect(driver.networkReached()).toEqual([])
    expect(run.wrongSends).toEqual([])
    expect(uncaughtProbes(run)).toEqual([])
  })

  // The eval command judges the ratchet itself, over every file's results (run.ts).
  it.skipIf(process.env[SKIP_RATCHET_ENV] === '1')("matches this platform's baseline", () => {
    const baseline = loadBaseline()
    expect(baseline).not.toBeNull()
    const verdict = tierBVerdict(collect(runs), baseline!, HOST)
    expect(verdict.ok, verdict.message).toBe(true)
  })
})
