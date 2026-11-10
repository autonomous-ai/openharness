import { describe, expect, it } from 'vitest'
import { githubRepository } from './repository.js'

describe('github repository addresses', () => {
  it('reads https, ssh and scp-like github.com addresses', () => {
    for (const url of ['https://github.com/acme/app', 'https://github.com/acme/app.git', 'https://github.com/acme/app/', 'http://github.com/acme/app',
      'https://GitHub.com/acme/app', 'ssh://git@github.com/acme/app.git', 'git@github.com:acme/app.git', 'git@github.com:acme/app']) {
      expect(githubRepository(url), url).toEqual({ owner: 'acme', name: 'app', fullName: 'acme/app' })
    }
    expect(githubRepository('https://github.com/a-b/my.repo_1')).toEqual({ owner: 'a-b', name: 'my.repo_1', fullName: 'a-b/my.repo_1' })
  })

  it('refuses other hosts, credentials, extra path parts and impossible names', () => {
    for (const url of [null, undefined, '', 'not a url', 'https://gitlab.com/acme/app', 'https://github.com.evil.test/acme/app',
      'https://user@github.com/acme/app', 'https://github.com:8443/acme/app', 'ssh://root@github.com/acme/app', 'git://github.com/acme/app',
      'https://github.com/acme', 'https://github.com/acme/app/tree/main', 'https://github.com/acme/app?x=1', 'https://github.com/-acme/app',
      'https://github.com/ac--me/app', 'https://github.com/acme/..', 'https://github.com/acme/a%20b', 'git@gitlab.com:acme/app.git']) {
      expect(githubRepository(url), String(url)).toBeNull()
    }
  })
})
