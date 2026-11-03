import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { githubAliases, resolveHost, type SshRunner } from './sshHosts.js'

/** An `ssh -G` that answers from a table, as the real one prints its resolved configuration. */
function fakeSsh(hosts: Record<string, string>): SshRunner & { asked: string[] } {
  const asked: string[] = []
  return Object.assign(vi.fn(async (args: readonly string[]) => {
    const alias = args.at(-1)!
    asked.push(alias)
    return `user git\nhostname ${hosts[alias] ?? alias}\nport 22\n`
  }), { asked })
}

describe('SSH host aliases', () => {
  let home: string
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'harness-ssh-hosts-')); await mkdir(join(home, '.ssh')) })
  afterEach(async () => { await rm(home, { recursive: true, force: true }) })

  it('resolves an alias through ssh -G, and never runs ssh for an unsafe name', async () => {
    const ssh = fakeSsh({ 'gh-work': 'GitHub.com' })
    expect(await resolveHost('gh-work', ssh)).toBe('github.com')
    expect(await resolveHost('-oProxyCommand=x', ssh)).toBeNull()
    expect(ssh).toHaveBeenCalledOnce()
    expect(vi.mocked(ssh).mock.calls[0]![0]).toStrictEqual(['-G', 'gh-work'])
  })

  it('reads nothing from an ssh that fails or prints no host name', async () => {
    expect(await resolveHost('gh-work', async () => { throw new Error('timeout') })).toBeNull()
    expect(await resolveHost('gh-work', async () => 'user git\n')).toBeNull()
  })

  it('lists the configuration\'s GitHub aliases in order, at most three, wildcards and other hosts left out', async () => {
    await writeFile(join(home, '.ssh', 'config'), [
      '# work and personal',
      'Host *',
      '  AddKeysToAgent yes',
      'Host gh-work gh-*-x !gh-bad',
      '  HostName github.com',
      'host=gitlab-work',
      '  HostName gitlab.com',
      'Host "gh-personal"',
      'Include conf.d/*.conf',
      'Host gh-late gh-later',
    ].join('\n'))
    await mkdir(join(home, '.ssh', 'conf.d'))
    await writeFile(join(home, '.ssh', 'conf.d', 'a.conf'), 'Host gh-included\nInclude ~/.ssh/deeper\n')
    await writeFile(join(home, '.ssh', 'conf.d', 'skip.txt'), 'Host gh-skipped\n')
    await writeFile(join(home, '.ssh', 'deeper'), 'Host gh-too-deep\n')
    const ssh = fakeSsh({ 'gh-work': 'github.com', 'gitlab-work': 'gitlab.com', 'gh-personal': 'github.com', 'gh-included': 'github.com',
      'gh-late': 'github.com', 'gh-too-deep': 'github.com', 'gh-skipped': 'github.com' })
    expect(await githubAliases({ home, ssh })).toStrictEqual(['gh-work', 'gh-personal', 'gh-included'])
    // Stops asking once it has three.
    expect(ssh.asked).toStrictEqual(['gh-work', 'gitlab-work', 'gh-personal', 'gh-included'])
  })

  it('counts an alias for GitHub\'s SSH over port 443 as GitHub', async () => {
    await writeFile(join(home, '.ssh', 'config'), 'Host gh-443\n  HostName ssh.github.com\n  Port 443\n')
    expect(await githubAliases({ home, ssh: fakeSsh({ 'gh-443': 'ssh.github.com' }) })).toStrictEqual(['gh-443'])
  })

  it('follows an absolute Include, and finds nothing without a configuration', async () => {
    const ssh = fakeSsh({ 'gh-a': 'github.com' })
    expect(await githubAliases({ home, ssh })).toStrictEqual([])
    await writeFile(join(home, 'elsewhere'), 'Host gh-a\n')
    await writeFile(join(home, '.ssh', 'config'), `Include ${join(home, 'elsewhere')} ${join(home, 'missing')}\nInclude ${join(home, 'nodir', '*.conf')}\n`)
    expect(await githubAliases({ home, ssh })).toStrictEqual(['gh-a'])
  })

  it('ignores a configuration too large to be one person\'s', async () => {
    await writeFile(join(home, '.ssh', 'config'), `Host gh-a\n${'#'.repeat(300 * 1024)}\n`)
    expect(await githubAliases({ home, ssh: fakeSsh({ 'gh-a': 'github.com' }) })).toStrictEqual([])
  })

  it('asks ssh about a bounded number of hosts', async () => {
    await writeFile(join(home, '.ssh', 'config'), Array.from({ length: 40 }, (_, i) => `Host h${i}`).join('\n'))
    const ssh = fakeSsh({})
    expect(await githubAliases({ home, ssh })).toStrictEqual([])
    expect(ssh.asked).toHaveLength(20)
  })
})
