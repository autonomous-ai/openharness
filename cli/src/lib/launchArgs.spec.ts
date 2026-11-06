import { describe, expect, it } from 'vitest'
import { LAUNCH_ARGS_MAX_CHARS, LAUNCH_ARGS_MAX_WORDS, parseLaunchArgs } from './launchArgs.js'

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
      '--settings', '--append-system-prompt', '--system-prompt', '--mcp-config', '--fork-session']
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
    const flags = ['--model', '-m', '--dangerously-bypass-approvals-and-sandbox', '--ask-for-approval', '-a', '--sandbox', '-s', '--profile', '-p']
    for (const flag of flags) expect(parseLaunchArgs('codex', `${flag}=x`)).toEqual(refusal(flag))
    expect(parseLaunchArgs('codex', 'resume').ok).toBe(false)
    expect(parseLaunchArgs('codex', 'fork --x').ok).toBe(false)
    expect(parseLaunchArgs('codex', '--search resume')).toEqual({ ok: true, args: ['--search', 'resume'] })
    expect(parseLaunchArgs('codex', '--continue')).toEqual({ ok: true, args: ['--continue'] })
  })

  it('applies only the generic rules to other engines', () => {
    expect(parseLaunchArgs('opencode', '--model x')).toEqual({ ok: true, args: ['--model', 'x'] })
  })
})
