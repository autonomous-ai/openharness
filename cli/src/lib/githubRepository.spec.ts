import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cloneAttempts, parseGitHubRepository, repositoryIdentity, resolvedRepositoryIdentity, safeSshAlias } from './githubRepository.js'

// The same file the desktop app's github_repository_vectors_test.dart reads: the daemon and the app must clone alike.
type Vectors = {
  parse: { input: string; expect: Record<string, string> | null }[]
  identity: { address: string; hosts: Record<string, string>; expect: string | null }[]
  attempts: { input: string; aliases: string[]; expect: string[] }[]
}
const vectors = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'github-repository-vectors.json'), 'utf8')) as Vectors

describe('a pasted GitHub repository address', () => {
  it.each(vectors.parse)('parses $input', ({ input, expect: wanted }) => {
    expect(parseGitHubRepository(input)).toStrictEqual(wanted)
  })

  it.each(vectors.identity)('names $address as one repository', async ({ address, hosts, expect: wanted }) => {
    expect(await resolvedRepositoryIdentity(address, async (host) => hosts[host] ?? null)).toBe(wanted)
  })

  it.each(vectors.attempts)('tries $input in order', ({ input, aliases, expect: wanted }) => {
    expect(cloneAttempts(parseGitHubRepository(input)!, aliases)).toStrictEqual(wanted)
  })

  it('resolves only the hosts an alias may name, and keeps github.com as it is', async () => {
    const asked: string[] = []
    const resolve = async (host: string) => { asked.push(host); return 'github.com' }
    expect(await resolvedRepositoryIdentity('https://github.com/o/r', resolve)).toBe('github.com/o/r')
    expect(await resolvedRepositoryIdentity('git@-oX:o/r', resolve)).toBe('-ox/o/r')
    expect(asked).toStrictEqual([])
    expect(repositoryIdentity('nonsense')).toBeNull()
  })

  it('takes a safe alias only', () => {
    expect(['gh-a', 'work.github', 'A1'].map(safeSshAlias)).toStrictEqual([true, true, true])
    expect(['-oX', '.a', '', 'a b', 'a'.repeat(64), 'a;b'].map(safeSshAlias)).toStrictEqual([false, false, false, false, false, false])
  })
})
