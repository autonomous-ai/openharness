import { describe, expect, it } from 'vitest'
import { checkLaunchWords, LAUNCH_ARGS_MAX_CHARS, LAUNCH_ARGS_MAX_WORDS, parseLaunchArgs } from './launchArgs.js'

const refusal = (flag: string) => ({ ok: false, detail: `${flag} is set by Harness and can't be added here.` })

describe('parseLaunchArgs', () => {
  it('splits words like a shell would, without running one', () => {
    expect(parseLaunchArgs('claude', '--chrome')).toEqual({ ok: true, args: ['--chrome'] })
    expect(parseLaunchArgs('claude', '  ')).toEqual({ ok: true, args: [] })
    expect(parseLaunchArgs('claude', `--add-dir "/a b" --x='y z' c\\ d`)).toEqual({ ok: true, args: ['--add-dir', '/a b', '--x=y z', 'c d'] })
    expect(parseLaunchArgs('claude', `--x "a\\"b\\\\c" 'd\\e'`)).toEqual({ ok: true, args: ['--x', 'a"b\\c', 'd\\e'] })
    expect(parseLaunchArgs('claude', `"" a`)).toEqual({ ok: true, args: ['', 'a'] })
  })

  it('refuses an unclosed quote or a trailing backslash', () => {
    const quote = parseLaunchArgs('claude', '--x "a')
    expect(quote.ok).toBe(false)
    expect(!quote.ok && quote.detail).toContain('quote')
    const single = parseLaunchArgs('claude', `--x 'a`)
    expect(!single.ok && single.detail).toContain('quote')
    const slash = parseLaunchArgs('claude', 'a\\')
    expect(slash.ok).toBe(false)
  })

  it('refuses too many words, too many characters, and NUL or newline', () => {
    const words = parseLaunchArgs('claude', Array.from({ length: LAUNCH_ARGS_MAX_WORDS + 1 }, () => 'a').join(' '))
    expect(words.ok).toBe(false)
    expect(!words.ok && words.detail).toContain('20')
    expect(parseLaunchArgs('claude', Array.from({ length: 20 }, () => 'a').join(' ')).ok).toBe(true)
    const long = parseLaunchArgs('claude', 'a'.repeat(LAUNCH_ARGS_MAX_CHARS + 1))
    expect(long.ok).toBe(false)
    expect(!long.ok && long.detail).toContain('1024')
    expect(parseLaunchArgs('claude', 'a'.repeat(LAUNCH_ARGS_MAX_CHARS)).ok).toBe(true)
    expect(parseLaunchArgs('claude', 'a\nb').ok).toBe(false)
    expect(parseLaunchArgs('claude', 'a\0b').ok).toBe(false)
  })

  it('refuses the flags Harness sets for Claude, bare, with =value, and quoted', () => {
    const flags = ['--resume', '-r', '--continue', '-c', '--model', '--permission-mode', '--dangerously-skip-permissions', '--session-id',
      '--settings', '--append-system-prompt', '--system-prompt', '--mcp-config', '--fork-session',
      // Added after the audit: each one replaces what Harness tells the agent or where its settings come from.
      '--setting-sources', '--append-system-prompt-file', '--system-prompt-file', '--effort']
    for (const flag of flags) {
      expect(parseLaunchArgs('claude', flag)).toEqual(refusal(flag))
      expect(parseLaunchArgs('claude', `${flag}=x`)).toEqual(refusal(flag))
    }
    expect(parseLaunchArgs('claude', '"--model"')).toEqual(refusal('--model'))
    expect(parseLaunchArgs('claude', '--chrome --model=opus')).toEqual(refusal('--model'))
  })

  it('allows a word that is only = or -, and Codex\'s -c', () => {
    expect(parseLaunchArgs('claude', '= -')).toEqual({ ok: true, args: ['=', '-'] })
    expect(parseLaunchArgs('codex', '-c model_reasoning_effort=high')).toEqual({ ok: true, args: ['-c', 'model_reasoning_effort=high'] })
  })

  it('refuses the flags Harness sets for Codex, and resume or fork as the first word', () => {
    const flags = ['--model', '-m', '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto', '--ask-for-approval', '-a', '--sandbox', '-s', '--profile', '-p']
    for (const flag of flags) expect(parseLaunchArgs('codex', `${flag}=x`)).toEqual(refusal(flag))
    expect(parseLaunchArgs('codex', 'resume').ok).toBe(false)
    expect(parseLaunchArgs('codex', 'fork --x').ok).toBe(false)
    expect(parseLaunchArgs('codex', '--continue')).toEqual({ ok: true, args: ['--continue'] })
  })

  it('refuses -- for every engine, since it would make Harness\'s own later arguments positional', () => {
    for (const engine of ['claude', 'codex', 'opencode'] as const) {
      expect(parseLaunchArgs(engine, '--chrome -- x').ok).toBe(false)
    }
  })

  it('refuses a refused short flag with its value attached, and still allows Codex -c k=v', () => {
    for (const word of ['-rabc', '-cfoo']) expect(parseLaunchArgs('claude', word).ok).toBe(false)
    for (const word of ['-mo3', '-sdanger-full-access', '-aon-request', '-pfoo']) expect(parseLaunchArgs('codex', word).ok).toBe(false)
    expect(parseLaunchArgs('claude', '-mo3').ok).toBe(true)
    expect(parseLaunchArgs('codex', '-c k=v')).toEqual({ ok: true, args: ['-c', 'k=v'] })
    expect(parseLaunchArgs('codex', '-cfoo=1').ok).toBe(true)
    expect(parseLaunchArgs('codex', '--search')).toEqual({ ok: true, args: ['--search'] })
  })

  it('refuses Codex resume or fork anywhere in the words', () => {
    expect(parseLaunchArgs('codex', '--search resume').ok).toBe(false)
    expect(parseLaunchArgs('codex', '-c k=v fork').ok).toBe(false)
    expect(parseLaunchArgs('claude', '--search resume').ok).toBe(true)
  })

  it('applies only the generic rules to other engines', () => {
    expect(parseLaunchArgs('opencode', '--model x')).toEqual({ ok: true, args: ['--model', 'x'] })
    expect(parseLaunchArgs('opencode', '-rabc')).toEqual({ ok: true, args: ['-rabc'] })
  })
})

describe('Codex config overrides', () => {
  const keys = ['model', 'model_provider', 'profile', 'sandbox_mode', 'approval_policy', 'developer_instructions', 'mcp_servers', 'mcp_servers.x.command', 'model_providers', 'model_providers.y.base_url']

  it('refuses a key Harness sets, as `k=v`, with the value as the next word, and attached', () => {
    for (const key of keys) {
      const detail = `-c ${key} is set by Harness and can't be added here.`
      for (const text of [`-c ${key}=x`, `--config ${key}=x`, `--config=${key}=x`, `-c${key}=x`, `-c=${key}=x`, `-c "${key}=x"`, `--search -c ${key}="a b"`]) {
        expect(parseLaunchArgs('codex', text), text).toEqual({ ok: false, detail })
      }
    }
  })

  it('allows every other key, and the same key for Claude, where -c is another flag', () => {
    for (const text of ['-c model_reasoning_effort=high', '--config=tools.web_search=true', '-cshell_environment_policy.inherit=all', '-c models=x', '-c modelx=1']) {
      expect(parseLaunchArgs('codex', text).ok, text).toBe(true)
    }
    // A trailing -c has no value to check; the engine itself refuses it at startup.
    expect(parseLaunchArgs('codex', '-c').ok).toBe(true)
    expect(parseLaunchArgs('claude', '--config model=x')).toEqual({ ok: true, args: ['--config', 'model=x'] })
  })
})

describe('checkLaunchWords', () => {
  it('accepts words the parser accepts and refuses the ones it refuses, with the same detail', () => {
    expect(checkLaunchWords('claude', ['--chrome', 'a b'])).toEqual({ ok: true })
    expect(checkLaunchWords('claude', [])).toEqual({ ok: true })
    expect(checkLaunchWords('claude', ['--settings', 'x'])).toEqual(refusal('--settings'))
    expect(checkLaunchWords('codex', ['-c', 'model=x'])).toEqual({ ok: false, detail: `-c model is set by Harness and can't be added here.` })
    expect(checkLaunchWords('codex', ['resume'])).toEqual(refusal('resume'))
    expect(checkLaunchWords('claude', ['a', '--', 'b']).ok).toBe(false)
  })

  it('refuses a hand-edited row the parser could never have produced', () => {
    expect(checkLaunchWords('claude', Array.from({ length: LAUNCH_ARGS_MAX_WORDS + 1 }, () => 'a')).ok).toBe(false)
    expect(checkLaunchWords('claude', ['a\nb']).ok).toBe(false)
    expect(checkLaunchWords('claude', ['a\0b']).ok).toBe(false)
  })
})
