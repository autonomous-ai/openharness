import { describe, expect, it } from 'vitest'
import { repositoryKey } from './repositoryKey.js'

describe('repositoryKey', () => {
  it('names a repository the same way over HTTPS and SSH, without credentials or case', () => {
    for (const url of ['https://github.com/Acme/App.git', 'https://someone:secret@github.com/acme/app/', 'git@github.com:Acme/App.git',
      'ssh://git@github.com:22/acme/app.git', ' HTTPS://GitHub.com/acme/app ']) expect(repositoryKey(url)).toBe('github.com/acme/app')
  })
  it('keeps nothing of a query or fragment, where a credential can be too', () => {
    for (const url of ['https://example.test/Acme/Repo.git?access_token=SYNTHETIC_SECRET', 'https://example.test/acme/repo#token=SYNTHETIC_SECRET',
      'git@example.test:acme/repo.git?access_token=SYNTHETIC_SECRET', 'ssh://git@example.test/acme/repo.git#SYNTHETIC_SECRET']) {
      expect(repositoryKey(url)).toBe('example.test/acme/repo')
    }
  })
  it('names nothing for a folder on disk or an address it cannot read', () => {
    for (const url of ['/srv/remote.git', 'file:///srv/remote.git', '', 'https://github.com', 'not a url']) expect(repositoryKey(url)).toBeNull()
  })
})
