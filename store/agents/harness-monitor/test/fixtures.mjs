/** Fixtures. Paths are placeholders on purpose — no real home directory belongs in a public repository. */

export const HOME = '/home/you'

export const HOUR = 3_600_000
export const DAY = 86_400_000

/** One agent frame in the shape `agents_list` replies with. */
export function frame(overrides = {}) {
  return {
    id: overrides.id ?? 'a1',
    sessionId: overrides.sessionId ?? 's1',
    name: overrides.name ?? 'widgets',
    title: overrides.title ?? 'Fix the reconciler',
    status: overrides.status ?? 'active',
    createdAt: new Date(overrides.createdAt ?? Date.now() - 7 * DAY).toISOString(),
    updatedAt: new Date(overrides.updatedAt ?? Date.now()).toISOString(),
    tmuxPane: overrides.tmuxPane ?? '%1',
    terminal: { available: true, primary: 'tmux\u0000%1', runtimes: [] },
    engine: overrides.engine ?? 'claude',
    selectedModel: overrides.selectedModel ?? 'runtime-v1:a1:claude:opus-5@high',
    project: overrides.project === null ? null : {
      name: 'widgets', cwd: `${HOME}/code/widgets`, root: `${HOME}/code/widgets`,
      remote: 'github.com/you/widgets', branch: 'main', ...(overrides.project ?? {}),
    },
    dsh: null, dshName: null, verdict: null, codexHome: null,
    // `createdAt`/`updatedAt` are already folded in above as ISO strings — never let a raw number through.
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['project', 'createdAt', 'updatedAt'].includes(key))),
  }
}

/** A tmux pane row as `panes()` returns it. */
export function pane(overrides = {}) {
  return { pane: '%1', dead: false, pid: 100, command: 'node', session: 'harness-claude-1', attached: false, target: 'harness-claude-1:1.1', engineExit: null, lastOutput: Date.now(), ...overrides }
}

/** A process table with one engine under one pane. */
export function table({ pid = 100, comm = '/usr/local/bin/claude', rss = 400 * 1024 * 1024, cpu = 0.2, children = [] } = {}) {
  const byPid = new Map([[pid, { pid, ppid: 1, rss, cpu, comm }]])
  const kids = new Map()
  if (children.length) {
    kids.set(pid, children.map((child) => child.pid))
    for (const child of children) byPid.set(child.pid, { ppid: pid, cpu: 0, rss: 0, ...child })
  }
  return { byPid, children: kids }
}

/** A row in the shape the policy and the actions take. */
export function row(overrides = {}) {
  return {
    id: 'a1', sessionId: 's1-0123456789ab', name: 'widgets', title: 'Fix the reconciler', engine: 'claude', model: 'opus-5',
    state: 'running', stateSince: Date.now(), pane: '%1', paneTarget: 'harness-claude-1:1.1',
    project: 'widgets', cwd: `${HOME}/code/widgets`, home: '~/code/widgets', branch: 'main',
    lastActivity: Date.now() - 6 * HOUR, idleMs: 6 * HOUR, createdAt: Date.now() - 7 * DAY,
    attached: false, working: false, needsInput: false, pinned: false, workspaceGone: false,
    rssBytes: 400 * 1024 * 1024, procs: 1, cpu: 0.1, enginePid: 100,
    machine: 'this machine', machineId: 'm1', local: true, dead: false,
    ...overrides,
  }
}

/** A fake tmux: records what it was asked, answers what the test set up. */
export function fakeTmux(answers = {}) {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    const key = args[0]
    if (key === 'show-options') return `${answers.remainOnExit ?? 'off'}\n`
    if (key === 'display-message') return `${answers.dead ? 1 : 0}§§${answers.command ?? 'zsh'}§§${answers.engineExit ?? ''}`
    if (key === 'capture-pane') return answers.screen ?? '$ '
    return ''
  }
  return { run, calls }
}
