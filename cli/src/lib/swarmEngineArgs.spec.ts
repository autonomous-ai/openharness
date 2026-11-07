import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { claudeShellGuardArgs, codexShellGuardArgs, shellGuardArgv } from './agentShellGuard.js'
import { swarmEngineArgs } from './swarmEngineArgs.js'

const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf('--settings') + 1]) as {
  disableAllHooks?: boolean
  hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string; args?: string[]; timeout: number }[] }[] }
}

describe('what the Swarm adds to an engine\'s argv', () => {
  it('turns off Codex\'s startup update check, whose "Update available" screen holds an agent nobody is at', () => {
    expect(swarmEngineArgs('codex').slice(0, 2)).toEqual(['-c', 'check_for_update_on_startup=false'])
  })

  it('runs the shell guard before each of a Swarm Claude Code session\'s shell and file-writing tools (task #3596)', () => {
    const args = swarmEngineArgs('claude')
    expect(args).toEqual(claudeShellGuardArgs())
    const blocks = settingsOf(args).hooks.PreToolUse
    expect(blocks).toHaveLength(1)
    expect(blocks[0].matcher).toBe('Bash|Write|Edit|MultiEdit|NotebookEdit')
    expect(blocks[0].hooks).toEqual([{ type: 'command', command: expect.stringContaining('__swarm-shell-guard'), timeout: 30 }])
  })

  it('re-enables hooks for a Swarm session even when inherited Claude settings disable all hooks', () => {
    const inherited = { disableAllHooks: true }
    const session = { ...inherited, ...settingsOf(swarmEngineArgs('claude')) }
    expect(session.disableAllHooks).toBe(false)
    expect(session.hooks.PreToolUse).toHaveLength(1)
  })

  it('runs it before each of a Swarm Codex session\'s tool calls, as a session flag', () => {
    expect(swarmEngineArgs('codex')).toEqual(['-c', 'check_for_update_on_startup=false', ...codexShellGuardArgs()])
    const [flag, value] = codexShellGuardArgs('darwin', ['/opt/node', '/x/cli.js', '__swarm-shell-guard'])
    expect(flag).toBe('-c')
    expect(value).toBe(`hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command="'/opt/node' '/x/cli.js' __swarm-shell-guard",timeout=30}]}]`)
  })

  it('starts the hook as each engine\'s runner on Windows takes it: exec form for Claude Code, a PowerShell line for Codex', () => {
    const argv = ['C:\\Harness\\node.exe', 'C:\\Harness\\cli\\cli.js', '__swarm-shell-guard']
    expect(settingsOf(claudeShellGuardArgs('win32', argv)).hooks.PreToolUse[0].hooks[0])
      .toEqual({ type: 'command', command: argv[0], args: argv.slice(1), timeout: 30 })
    expect(codexShellGuardArgs('win32', argv)[1]).toContain(JSON.stringify(`& '${argv[0]}' '${argv[1]}' ${argv[2]}`))
  })

  it('runs the hook from a source checkout with its TypeScript loader', () => {
    const [program, ...args] = shellGuardArgv()
    const run = spawnSync(program, args, { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'sudo ls' } }),
      encoding: 'utf8', timeout: 15_000, windowsHide: true })
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' })
    expect(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('adds nothing for the other engines', () => {
    for (const engine of ['opencode', 'gemini', 'not-an-engine']) expect(swarmEngineArgs(engine)).toEqual([])
  })

  it('hands out a copy, so a caller\'s edit never reaches the next launch', () => {
    swarmEngineArgs('codex').push('--oops')
    expect(swarmEngineArgs('codex')).not.toContain('--oops')
  })
})
