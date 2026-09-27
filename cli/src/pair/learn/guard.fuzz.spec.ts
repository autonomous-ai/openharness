/**
 * Property tests for the guards (daemons/LEARNING.md, "Untrusted text"). fast-check is not a dependency, so
 * inputs come from a small seeded generator (mulberry32): every run sees the same cases, and a failure names
 * its seed and case.
 *
 * Invariants:
 *   - every credential shape redact() is built for is gone from its output, wherever it sits (start or end of
 *     a line, in quotes, in JSON, in a code fence, after `=` or `:`, beside punctuation, in unicode text),
 *     and the words around it survive;
 *   - hasSecret() sees every one of them, so a lesson carrying one is refused ('secret');
 *   - redact() is idempotent, and leaves ordinary text alone;
 *   - redact()/untrusted()/refusal() stay linear on long hostile input (a daemon's event loop runs them).
 */
import { describe, expect, it } from 'vitest'
import { codeSpan, hasSecret, inert, redact, redactDeep, refusal, untrusted } from './guard.js'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const DIGITS = '0123456789'
const ALNUM = UPPER + LOWER + DIGITS
const B64 = `${ALNUM}+/`
const B64URL = `${ALNUM}-_`

interface Gen { rand: () => number; int: (lo: number, hi: number) => number; pick: <T>(xs: readonly T[]) => T; str: (alphabet: string, n: number) => string }
function gen(seed: number): Gen {
  const rand = mulberry32(seed)
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1))
  return {
    rand, int,
    pick: <T,>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!,
    str: (alphabet: string, n: number): string => Array.from({ length: n }, () => alphabet[int(0, alphabet.length - 1)]).join(''),
  }
}

/** A generated credential: the text to embed, and the parts of it that must never survive redaction. */
interface Secret { cls: string; text: string; secret: string[] }

const SECRET_CLASSES: Record<string, (g: Gen) => Secret> = {
  'aws-access-key': (g) => { const t = `${g.pick(['AKIA', 'ASIA'])}${g.str(UPPER + DIGITS, 16)}`; return { cls: 'aws-access-key', text: t, secret: [t] } },
  'aws-secret-key': (g) => {
    const key = g.str(B64, 40)
    const name = g.pick(['aws_secret_access_key', 'AWS_SECRET_ACCESS_KEY', 'SecretAccessKey', 'secret_key', 'aws-secret-key'])
    const sep = g.pick(['=', ' = ', ': ', '="', "='", '": "'])
    return { cls: 'aws-secret-key', text: `${name}${sep}${key}${sep.includes('"') ? '"' : sep.includes("'") ? "'" : ''}`, secret: [key] }
  },
  'github-token': (g) => {
    const t = g.rand() < 0.2 ? `github_pat_${g.str(ALNUM, 22)}_${g.str(ALNUM, 59)}` : `${g.pick(['ghp', 'gho', 'ghu', 'ghs', 'ghr'])}_${g.str(ALNUM, 36)}`
    return { cls: 'github-token', text: t, secret: [t.slice(4)] }
  },
  'jwt': (g) => {
    const t = `eyJ${g.str(B64URL, g.int(15, 60))}.eyJ${g.str(B64URL, g.int(20, 200))}.${g.str(B64URL, g.int(43, 86))}`
    return { cls: 'jwt', text: t, secret: [t.slice(3, 40), t.split('.')[2]!] }
  },
  'private-key': (g) => {
    const kind = g.pick(['RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'DSA PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PRIVATE KEY', 'PGP PRIVATE KEY BLOCK'])
    const lines = Array.from({ length: g.int(1, 8) }, () => g.str(B64, 64))
    const nl = g.pick(['\n', '\r\n'])
    const text = [`-----BEGIN ${kind}-----`, ...lines, `-----END ${kind}-----`].join(nl)
    return { cls: 'private-key', text, secret: [...lines, 'PRIVATE KEY'] }
  },
  'url-password': (g) => {
    const scheme = g.pick(['https', 'http', 'postgres', 'postgresql+psycopg2', 'mongodb+srv', 'redis', 'amqp', 'ftp', 'git+ssh', 'HTTPS'])
    const user = g.str(LOWER + DIGITS, g.int(3, 12))
    const pass = g.str(`${ALNUM}._~!$&*+,;=%-`, g.int(8, 32))
    const host = `${g.str(LOWER, g.int(3, 10))}.${g.pick(['com', 'io', 'internal', 'example.org'])}`
    return { cls: 'url-password', text: `${scheme}://${user}:${pass}@${host}${g.pick(['', ':5432', '/db', '/org/repo.git?x=1'])}`, secret: [pass, `${user}:`] }
  },
  'anthropic-openai-key': (g) => { const t = `sk-${g.pick(['ant-', 'proj-', ''])}${g.str(`${ALNUM}_-`, g.int(20, 90))}`; return { cls: 'sk', text: t, secret: [t.slice(3)] } },
  'gitlab-token': (g) => { const t = `glpat-${g.str(`${ALNUM}_-`, 20)}`; return { cls: 'gitlab', text: t, secret: [t.slice(6)] } },
  'slack-token': (g) => { const t = `xox${g.pick([...'abposr'])}-${g.str(`${DIGITS}-`, 12)}${g.str(ALNUM, 24)}`; return { cls: 'slack', text: t, secret: [t.slice(5)] } },
  'google-api-key': (g) => { const t = `AIza${g.str(`${ALNUM}_-`, 35)}`; return { cls: 'google', text: t, secret: [t] } },
  'npm-token': (g) => { const t = `npm_${g.str(ALNUM, 36)}`; return { cls: 'npm', text: t, secret: [t.slice(4)] } },
  'bearer': (g) => {
    const t = g.str(`${ALNUM}._~+/-`, g.int(20, 60))
    return { cls: 'bearer', text: `${g.pick(['Authorization: Bearer', 'authorization: bearer', 'Authorization: Basic', 'auth: Bearer', 'X-Auth-Token: Bearer', 'token: Bearer'])} ${t}`, secret: [t] }
  },
  'assigned': (g) => {
    const name = g.pick(['password', 'DB_PASSWORD', 'passwd', 'pwd', 'api_key', 'apiKey', 'X-Api-Key', 'access_key', 'client_secret', 'secret', 'token', 'refresh_token', 'auth', 'credentials', 'private_key', 'MY_APP_PROD_DB_PASSWORD'])
    const value = g.str(`${ALNUM}!#%&*+-./:?@^_~`, g.int(8, 40)).replace(/^[^A-Za-z0-9]/, 'x')
    const [open, close] = g.pick([['=', ''], [': ', ''], ['="', '"'], ["='", "'"], ['": "', '"'], [' = ', ''], [':', '']])
    return { cls: 'assigned', text: `${name}${open}${value}${close}`, secret: [value] }
  },
  'quoted-passphrase': (g) => {
    const words = Array.from({ length: g.int(2, 5) }, () => g.str(LOWER, g.int(6, 10)))
    const q = g.pick(['"', "'"])
    return { cls: 'quoted-passphrase', text: `${g.pick(['"password": ', 'password=', 'secret: ', 'token = '])}${q}${words.join(' ')}${q}`, secret: words }
  },
}

/** Where a credential turns up in real text. None puts a word character right before it (no word boundary). */
const CONTEXTS: Array<(s: string) => string> = [
  (s) => s,
  (s) => `${s}\nALPHA done OMEGA`,
  (s) => `ALPHA begin OMEGA\n${s}`,
  (s) => `ALPHA "${s}" OMEGA`,
  (s) => `ALPHA '${s}' OMEGA`,
  (s) => `{"ALPHA": "x", "value": ${JSON.stringify(s)}, "OMEGA": 1}`,
  (s) => `ALPHA\n\`\`\`sh\n${s}\n\`\`\`\nOMEGA`,
  (s) => `ALPHA key=${s} OMEGA`,
  (s) => `ALPHA key: ${s}; OMEGA`,
  (s) => `ALPHA (${s}), OMEGA.`,
  (s) => `ALPHA [${s}] OMEGA!`,
  (s) => `ALPHA <${s}> OMEGA?`,
  (s) => `日本語のテキスト ALPHA ${s} ✓ OMEGA — ünïcödé`,
  (s) => `ALPHA\t${s}\tOMEGA`,
  (s) => `  - ALPHA ${s}\n  - OMEGA`,
  (s) => `export ALPHA=1 && echo ${s} # OMEGA`,
]

const SEEDS = [1, 7, 42, 1337, 20260926, 0xdeadbeef]
const PER_SEED = 400

describe('redact(): every generated credential is gone, in every context', () => {
  for (const [name, make] of Object.entries(SECRET_CLASSES)) {
    it(`${name}`, () => {
      let checked = 0
      for (const seed of SEEDS) {
        const g = gen(seed ^ name.length * 7919)
        for (let i = 0; i < PER_SEED / 4; i++) {
          const secret = make(g)
          const context = g.pick(CONTEXTS)
          // JSON.stringify escapes a key's newlines as \n: the JSON context holds the escaped form.
          const text = context(secret.text)
          const out = redact(text)
          const where = `seed ${seed} case ${i}: ${JSON.stringify(text)} -> ${JSON.stringify(out)}`
          for (const part of secret.secret) expect(out.includes(part), where).toBe(false)
          if (text.includes('ALPHA')) expect(out, where).toContain('ALPHA')
          if (text.includes('OMEGA')) expect(out, where).toContain('OMEGA')
          expect(redact(out), `idempotent: ${where}`).toBe(out)
          expect(hasSecret(text), `hasSecret: ${where}`).toBe(true)
          checked++
        }
      }
      expect(checked).toBe(SEEDS.length * (PER_SEED / 4))
    })
  }

  it('several credentials in one text all go, and a lesson carrying any of them is refused', () => {
    const makers = Object.values(SECRET_CLASSES)
    for (const seed of SEEDS) {
      const g = gen(seed)
      for (let i = 0; i < 100; i++) {
        const secrets = Array.from({ length: g.int(2, 5) }, () => g.pick(makers)(g))
        const text = secrets.map((s) => g.pick(CONTEXTS)(s.text)).join(g.pick(['\n', ' ', ' | ', '\n\n']))
        const out = redact(text)
        for (const s of secrets) for (const part of s.secret) expect(out.includes(part), `seed ${seed} case ${i}: ${JSON.stringify(text)}`).toBe(false)
        expect(refusal(`Remember: ${text}`), text).not.toBeNull()
      }
    }
  })

  it('redactDeep takes them out of every string of a record, and keeps its shape', () => {
    const g = gen(99)
    const makers = Object.values(SECRET_CLASSES)
    for (let i = 0; i < 200; i++) {
      const a = g.pick(makers)(g)
      const b = g.pick(makers)(g)
      const record = { id: 7, ok: true, none: null, text: a.text, list: ['plain words', b.text, 3], nested: { deep: [{ v: `ALPHA ${a.text} OMEGA` }] } }
      const out = redactDeep(record)
      const flat = JSON.stringify(out)
      for (const part of [...a.secret, ...b.secret]) expect(flat.includes(part), flat).toBe(false)
      expect(out).toMatchObject({ id: 7, ok: true, none: null, list: ['plain words', expect.any(String), 3] })
      expect(out.nested.deep[0]!.v).toMatch(/^ALPHA .* OMEGA$/s)
    }
  })
})

describe('redact(): emails and home folders', () => {
  it('an email goes wherever it is; git@host:org/repo stays', () => {
    const g = gen(5)
    for (let i = 0; i < 300; i++) {
      const email = `${g.str(`${LOWER}${DIGITS}._+-`, g.int(1, 20)).replace(/^[._+-]+/, 'a')}@${g.str(LOWER, g.int(2, 12))}.${g.pick(['com', 'co.uk', 'io', 'dev'])}`
      const text = g.pick(CONTEXTS)(email)
      const out = redact(text)
      expect(out.includes(email), `${text} -> ${out}`).toBe(false)
      expect(out).toContain('[email]')
    }
    expect(redact('git clone git@github.com:org/repo.git')).toBe('git clone git@github.com:org/repo.git')
  })

  it('home folders become ~, on macOS, Linux and Windows, and the given home too', () => {
    const g = gen(11)
    for (let i = 0; i < 200; i++) {
      const user = g.str(LOWER + DIGITS, g.int(2, 12))
      const rest = `${g.pick(['code', 'src', '.ssh', 'Library'])}/${g.str(LOWER, 5)}`
      const home = g.pick([`/Users/${user}`, `/home/${user}`])
      const text = g.pick(CONTEXTS)(`${home}/${rest}`)
      const out = redact(text)
      expect(out, text).not.toContain(user)
      expect(out, text).toContain(`~/${rest}`)
      expect(redact(`C:\\Users\\${user}\\AppData`)).toBe('~\\AppData')
    }
    expect(redact('cd /srv/me/project && ls /srv/me', { home: '/srv/me/' })).toBe('cd ~/project && ls ~')
    // A home of `/` (or nothing) is never swapped for ~: that would eat every slash.
    expect(redact('ls /etc/hosts', { home: '/' })).toBe('ls /etc/hosts')
    expect(redact('ls /etc/hosts', { home: null })).toBe('ls /etc/hosts')
  })
})

describe('redact(): ordinary text is left alone', () => {
  const WORDS = ['npm', 'run', 'test', 'git', 'status', 'src/index.ts', 'the', 'build', 'failed', 'with', 'exit', 'code', '1', 'pnpm', 'install',
    '--frozen-lockfile', 'README.md', 'token', 'password', 'key', 'secret', 'auth', 'a-b-c', 'v1.2.3', 'x86_64', 'feature/login', '(done)', 'ok:', '=>',
    'http://localhost:3000/api', 'https://example.com/docs#auth', '$API_KEY', '<your-token>', '{secret}', 'token=$TOKEN', 'password: <password>']
  it('no credential, no change: redact is the identity and hasSecret is false', () => {
    for (const seed of SEEDS) {
      const g = gen(seed)
      for (let i = 0; i < 300; i++) {
        const text = Array.from({ length: g.int(1, 25) }, () => g.pick(WORDS)).join(g.pick([' ', '\n', ' ', ', ']))
        expect(redact(text), text).toBe(text)
        expect(hasSecret(text), text).toBe(false)
      }
    }
  })
})

describe('bounded time on long hostile input', () => {
  // A tool's output or a web page an agent read can hold anything. These shapes made the old patterns
  // quadratic (each word boundary rescanned the rest of the line): 40 KB took seconds on one core.
  const hostile: Record<string, string> = {
    'dashed words': 'a-'.repeat(100_000),
    'dotted words': 'a.'.repeat(100_000),
    'plus words': 'a+'.repeat(100_000),
    'an @ before dotted labels': `a@${'b.'.repeat(100_000)}`,
    'uuids joined by dashes': Array.from({ length: 5_000 }, () => '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0').join('-'),
    'underscored segments': 'a1-b_'.repeat(40_000),
    'a key with no end': `-----BEGIN RSA PRIVATE KEY-----${'A'.repeat(200_000)}`,
    'many assignments': 'token='.repeat(40_000),
    'many schemes': 'a://'.repeat(50_000),
    'spaces': ' '.repeat(200_000),
    'jwt-ish': `eyJ${'a'.repeat(20)}.`.repeat(20_000),
  }
  for (const [name, text] of Object.entries(hostile)) {
    it(`${name} (${Math.round(text.length / 1000)} KB)`, () => {
      const start = performance.now()
      redact(text)
      untrusted(text, 300)
      hasSecret(text)
      expect(performance.now() - start, name).toBeLessThan(1_500)
    })
  }
})

describe('the small helpers', () => {
  it('inert/codeSpan/untrusted take null and undefined as empty', () => {
    expect(inert(null as unknown as string)).toBe('')
    expect(inert(undefined as unknown as string)).toBe('')
    expect(codeSpan('')).toBe('`?`')
    expect(codeSpan(null as unknown as string)).toBe('`?`')
    expect(untrusted(undefined as unknown as string, 10)).toBe('')
  })

  it('a code span is one printable line with no backtick, however it was written', () => {
    const g = gen(3)
    for (let i = 0; i < 500; i++) {
      const raw = g.str(`${ALNUM}\`\n\r\t\x00\x1b\x7f é漢 -_.`, g.int(0, 200))
      const span = codeSpan(raw, 60)
      expect(span.startsWith('`') && span.endsWith('`')).toBe(true)
      const inner = span.slice(1, -1)
      expect(inner).not.toMatch(/[`\x00-\x1f\x7f]/)
      expect(inner).toMatch(/^[\x20-\x7e]*$/)
      expect(inner.length).toBeLessThanOrEqual(60)
    }
  })
})

describe('regressions the generator found (each leaked before its fix in guard.ts)', () => {
  it('a temporary AWS key id (ASIA…) goes like a long-term one (AKIA…)', () => {
    expect(redact('AWS_ACCESS_KEY_ID ASIAY34FZKBOKMUTVV7A in use')).toBe('AWS_ACCESS_KEY_ID [redacted] in use')
    expect(hasSecret('ASIAY34FZKBOKMUTVV7A')).toBe(true)
  })

  it("AWS's own JSON (`aws sts get-session-token`): camelCase names, every value gone", () => {
    const sts = '{"Credentials": {"AccessKeyId": "ASIAY34FZKBOKMUTVV7A", "SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "SessionToken": "FwoGZXIvYXdzEBYaDHhBTEXAMPLETOKEN", "Expiration": "2026-09-27T00:00:00Z"}}'
    const out = redact(sts)
    for (const leaked of ['ASIAY34FZ', 'wJalrXUtnFEMI', 'FwoGZXIvYXdz']) expect(out).not.toContain(leaked)
    expect(out).toContain('"SecretAccessKey": "[redacted]"')
    expect(out).toContain('"SessionToken": "[redacted]"')
    expect(out).toContain('"Expiration": "2026-09-27T00:00:00Z"')
    expect(refusal(`Use these: ${sts}`)).toBe('secret')
  })

  it('an armored PGP private key block goes, lines and all', () => {
    const key = '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBF4AAAAAAQgA0bZ2p\n=abcd\n-----END PGP PRIVATE KEY BLOCK-----'
    expect(redact(`before\n${key}\nafter`)).toBe('before\n[redacted]\nafter')
    expect(refusal(key)).toBe('secret')
  })

  it('a Google API key that ends in `-` goes', () => {
    const k = 'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6-'
    expect(k).toHaveLength(39)
    expect(redact(`key ${k} done`)).toBe('key [redacted] done')
  })

  it('a bearer token assigned to a name (`auth: Bearer …`, `X-Auth-Token: Bearer …`) goes whole', () => {
    expect(redact('auth: Bearer abcdefghijklmnopqrstuvwx')).not.toContain('abcdefghijklmnop')
    expect(redact('X-Auth-Token: Bearer abcdefghijklmnopqrstuvwx')).not.toContain('abcdefghijklmnop')
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstuvwx')).toBe('Authorization: Bearer [redacted]')
  })

  it('JSON escaped inside a string (a log line holding a request body) loses its password', () => {
    const line = String.raw`{"body": "{\"user\": \"me\", \"password\": \"hunter2hunter2\"}"}`
    const out = redact(line)
    expect(out).not.toContain('hunter2')
    expect(out).toBe(String.raw`{"body": "{\"user\": \"me\", \"password\": \"[redacted]\"}"}`)
    // Still valid JSON, with the same shape.
    expect(JSON.parse(JSON.parse(out).body)).toEqual({ user: 'me', password: '[redacted]' })
    // An unquoted value keeps a backslash that is its own.
    expect(redact(String.raw`password=abc\defghi next`)).toBe('password=[redacted] next')
  })

  it('a quoted passphrase goes whole, not only its first word', () => {
    expect(redact('"password": "correct horse battery staple"')).toBe('"password": "[redacted]"')
    expect(redact("secret: 'two words' and more")).toBe("secret: '[redacted]' and more")
    // A quoted reference stays a reference.
    expect(redact('"token": "$GITHUB_TOKEN"')).toBe('"token": "$GITHUB_TOKEN"')
    expect(redact("password: '<your password>'")).toBe("password: '<your password>'")
  })

  it('a long line of hyphenated words is linear, not seconds', () => {
    const start = performance.now()
    redact('a-'.repeat(20_000))
    redact(`a@${'b.'.repeat(40_000)}`)
    expect(performance.now() - start).toBeLessThan(500)
  })
})
