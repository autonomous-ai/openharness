import { describe, expect, it } from 'vitest'
import { hasSecret, redact } from './guard.js'

/**
 * Where a secret's name may start: at the start of a name (`DB_PASSWORD`, `x-api-key`, `aws_secret_access_key`)
 * or at a camelCase hump (`SecretAccessKey`, `SessionToken`) — never inside a word. A lesson that says
 * `oauth: enabled` holds no credential, and `hasSecret` refusing it would lose the lesson for nothing.
 */
describe('a secret name is a name, not a piece of a word', () => {
  it.each([
    'oauth: enabled', 'OAuth=configured', 'xauth=display0', 'nopassword=trueish', 'userpwd: unknown',
    'the author: someone famous', 'tokenizer: whitespace', 'passwords: rotated weekly', 'max_tokens: 4096',
  ])('%s is not a secret, and is left as it is', (text) => {
    expect(hasSecret(text)).toBe(false)
    expect(redact(text)).toBe(text)
  })

  it.each([
    ['DB_PASSWORD=hunter2222', 'DB_PASSWORD=[redacted]'],
    ['MYSQL_ROOT_PASSWORD: s3cr3tpw', 'MYSQL_ROOT_PASSWORD: [redacted]'],
    ['x-api-key: abcdef123456', 'x-api-key: [redacted]'],
    ['aws_secret_access_key = wJalrXUtnFEMIK7MDENG', 'aws_secret_access_key = [redacted]'],
    ['"SecretAccessKey": "wJalrXUtnFEMI/K7MDENG"', '"SecretAccessKey": "[redacted]"'],
    ['SessionToken=FwoGZXIvYXdzEJr', 'SessionToken=[redacted]'],
    ['csrfToken: 9f8e7d6c5b4a', 'csrfToken: [redacted]'],
    ['apiKey: "sk_live_abcdef12"', 'apiKey: "[redacted]"'],
    ['GITHUB_TOKEN=abcdef123456', 'GITHUB_TOKEN=[redacted]'],
    // A word that is not a name does not hide the name after it.
    ['oauth:password=hunter22', 'oauth:password=[redacted]'],
  ])('%s is a secret: the value goes, the name stays', (text, want) => {
    expect(hasSecret(text)).toBe(true)
    expect(redact(text)).toBe(want)
  })

  it('stays linear on lines built from names that are pieces of words', () => {
    const started = performance.now()
    for (const line of ['oauth='.repeat(8000), 'a_auth='.repeat(6000), 'Token:'.repeat(7000), `${'aA'.repeat(20_000)}Token=x`]) {
      redact(line)
      hasSecret(line)
    }
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
