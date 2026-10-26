import { describe, expect, it } from 'vitest'
import { CREDENTIAL_LABELS, CREDENTIAL_MARKER, credentialResult, findCredentials, redactCredentials, type CredentialKind } from './credentials.js'

// Every credential below is assembled at run time from obviously fake parts, so the repository holds nothing a secret
// scanner (or a person) could mistake for a real one.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const UPPER32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const B64 = `${ALNUM}+/`
const B64URL = `${ALNUM}-_`
/** Deterministic noise with letters and digits. */
function noise(length: number, alphabet = ALNUM, seed = 7): string {
  let out = '', x = seed
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out += alphabet[(x >>> 16) % alphabet.length]
  }
  return /\d/.test(out) || !/\d/.test(alphabet) ? out : `${out.slice(0, -1)}7`
}
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const fake = {
  jwt: (seed = 1) => [b64url({ alg: 'HS256', typ: 'JWT' }), b64url({ sub: 'fixture-user', exp: 1 }), noise(43, B64URL, seed)].join('.'),
  jwe: () => [b64url({ alg: 'RSA-OAEP', enc: 'A256GCM' }), noise(40, B64URL, 2), noise(16, B64URL, 3), noise(30, B64URL, 4), noise(22, B64URL, 5)].join('.'),
  harness: (prefix: string, seed = 11) => `${prefix}_${noise(43, B64URL, seed)}`,
  github: (prefix: string, seed = 12) => `${prefix}_${noise(36, ALNUM, seed)}`,
  githubPat: () => ['github', 'pat', `${noise(22, ALNUM, 13)}_${noise(59, ALNUM, 14)}`].join('_'),
  anthropic: () => ['sk', 'ant', 'api03', noise(93, B64URL, 15)].join('-'),
  openai: (kind = '') => ['sk', ...(kind ? [kind] : []), noise(48, ALNUM, 16)].join('-'),
  awsKeyId: (prefix = 'AKIA') => prefix + noise(16, UPPER32, 17),
  awsSecret: () => noise(40, B64, 18),
  slack: (kind = 'b') => [`xox${kind}`, '1234567890', '9876543210', noise(24, ALNUM, 19)].join('-'),
  google: () => ['AI', 'za', noise(35, B64URL, 20)].join(''),
  pem: (kind = 'RSA PRIVATE') => [`-----BEGIN ${kind} KEY-----`, noise(64, B64, 21), noise(64, B64, 22), `${noise(20, B64, 23)}==`, `-----END ${kind} KEY-----`].join('\n'),
  password: () => `Fx${noise(16, ALNUM, 24)}`,
}

describe('findCredentials: every kind it removes', () => {
  const cases: Array<[CredentialKind, string, string]> = [
    ['jwt', 'a signed JWT', fake.jwt()],
    ['jwt', 'an encrypted JWT (five segments)', fake.jwe()],
    ['harness', 'a Harness access token', fake.harness('hna')],
    ['harness', 'a Harness refresh token', fake.harness('hnr')],
    ['harness', 'a Harness team access token', fake.harness('hta')],
    ['harness', 'a Harness team refresh token', fake.harness('htr')],
    ['harness', 'a Harness handoff code', fake.harness('hnh')],
    ['harness', 'a Harness sign-in QR code', fake.harness('hnq')],
    ['harness', 'a Harness QR poll token', fake.harness('hnp')],
    ['github', 'a GitHub personal access token', fake.github('ghp')],
    ['github', 'a GitHub OAuth token', fake.github('gho')],
    ['github', 'a GitHub user-to-server token', fake.github('ghu')],
    ['github', 'a GitHub server-to-server token', fake.github('ghs')],
    ['github', 'a GitHub refresh token', fake.github('ghr')],
    ['github', 'a fine-grained GitHub token', fake.githubPat()],
    ['anthropic', 'an Anthropic key', fake.anthropic()],
    ['openai', 'a legacy OpenAI key', fake.openai()],
    ['openai', 'an OpenAI project key', fake.openai('proj')],
    ['openai', 'an OpenAI service account key', fake.openai('svcacct')],
    ['aws-key-id', 'an AWS access key id', fake.awsKeyId()],
    ['aws-key-id', 'an AWS temporary access key id', fake.awsKeyId('ASIA')],
    ['slack', 'a Slack bot token', fake.slack('b')],
    ['slack', 'a Slack user token', fake.slack('p')],
    ['slack', 'a Slack app token', fake.slack('a')],
    ['google', 'a Google API key', fake.google()],
    ['private-key', 'a PEM RSA private key', fake.pem()],
    ['private-key', 'a PKCS#8 private key', fake.pem('PRIVATE')],
    ['private-key', 'an OpenSSH private key', fake.pem('OPENSSH PRIVATE')],
    ['private-key', 'an encrypted private key', fake.pem('ENCRYPTED PRIVATE')],
    ['private-key', 'an EC private key', fake.pem('EC PRIVATE')],
  ]
  for (const [kind, what, secret] of cases) {
    it(`removes ${what} and keeps the words around it`, () => {
      const text = `Here it is: ${secret}\nThanks, I will rotate it later.`
      expect(findCredentials(text).map(f => f.kind)).toEqual([kind])
      expect(redactCredentials(text)).toEqual({ text: `Here it is: ${CREDENTIAL_MARKER}\nThanks, I will rotate it later.`, removed: [kind] })
      // On its own, in quotes, in parentheses, after an equals sign, at the end of a sentence.
      for (const [before, after] of [['', ''], ['"', '"'], ["'", "'"], ['(', ')'], ['TOKEN=', ''], ['`', '`'], ['see ', '.'], ['<', '>']]) {
        expect(redactCredentials(`${before}${secret}${after}`).text).toBe(`${before}${CREDENTIAL_MARKER}${after}`)
      }
    })
  }

  it('removes an AWS secret access key when it is labelled, keeping the label', () => {
    const secret = fake.awsSecret()
    for (const label of ['aws_secret_access_key = ', 'AWS_SECRET_ACCESS_KEY=', '"SecretAccessKey": "', 'aws secret key: ', 'secret_access_key: ']) {
      expect(redactCredentials(`${label}${secret}`)).toEqual({ text: `${label}${CREDENTIAL_MARKER}`, removed: ['aws-secret'] })
    }
    // Unlabelled, 40 base64 characters are as likely a hash: left alone.
    expect(findCredentials(`checksum ${secret}`)).toEqual([])
  })

  it('removes a long random value given as a password, token or secret, keeping the key', () => {
    const value = fake.password()
    for (const assignment of [`password=${value}`, `DB_PASSWORD="${value}"`, `"token": "${value}"`, `token: ${value}`, `secret=${value}`,
      `client_secret: '${value}'`, `x-api-key: ${value}`, `apiKey => ${value}`, `access_token=${value}&state=abc`, `--token=${value}`,
      `export SESSION_SECRET=${value}`, `credentials := ${value}`, `PASSPHRASE=${value}`, `private_key: ${value}`]) {
      const { text, removed } = redactCredentials(assignment)
      expect(removed, assignment).toEqual(['password'])
      expect(text, assignment).toBe(assignment.replace(value, CREDENTIAL_MARKER))
    }
    expect(redactCredentials(`The password: ${value}.`).text).toBe(`The password: ${CREDENTIAL_MARKER}.`)
  })

  it('removes Authorization header values, a bare bearer token and a password in a URL', () => {
    const value = fake.password()
    const basic = Buffer.from(`fixture-user:${value}`).toString('base64')
    expect(redactCredentials(`curl -H "Authorization: Bearer ${value}" https://api.example.test`).text)
      .toBe(`curl -H "Authorization: Bearer ${CREDENTIAL_MARKER}" https://api.example.test`)
    expect(redactCredentials(`authorization: Basic ${basic}`).text).toBe(`authorization: Basic ${CREDENTIAL_MARKER}`)
    expect(redactCredentials(`send it with Bearer ${value}${noise(6, ALNUM, 30)} please`).text).toBe(`send it with Bearer ${CREDENTIAL_MARKER} please`)
    expect(redactCredentials(`DATABASE_URL=postgres://app:${value}@db.internal:5432/app`).text)
      .toBe(`DATABASE_URL=postgres://app:${CREDENTIAL_MARKER}@db.internal:5432/app`)
  })

  it('names a known credential by its own kind when it is also labelled', () => {
    expect(redactCredentials(`GITHUB_TOKEN=${fake.github('ghp')}`)).toEqual({ text: `GITHUB_TOKEN=${CREDENTIAL_MARKER}`, removed: ['github'] })
    expect(redactCredentials(`Authorization: Bearer ${fake.jwt()}`)).toEqual({ text: `Authorization: Bearer ${CREDENTIAL_MARKER}`, removed: ['jwt'] })
    expect(redactCredentials(`git clone https://x-access-token:${fake.github('ghs')}@github.com/example/repo`).removed).toEqual(['github'])
    expect(redactCredentials(`aws_access_key_id = ${fake.awsKeyId()}`).removed).toEqual(['aws-key-id'])
  })

  it('removes several credentials of several kinds from one message, in order', () => {
    const text = `JWT ${fake.jwt()} and ${fake.github('ghp')}, then ${fake.jwt(2)}; keys:\n${fake.pem()}\nend`
    const { text: redacted, removed } = redactCredentials(text)
    expect(removed).toEqual(['jwt', 'github', 'jwt', 'private-key'])
    expect(redacted).toBe(`JWT ${CREDENTIAL_MARKER} and ${CREDENTIAL_MARKER}, then ${CREDENTIAL_MARKER}; keys:\n${CREDENTIAL_MARKER}\nend`)
  })

  it('keeps a full stop after a JWT and removes the whole of a cut-off private key', () => {
    expect(redactCredentials(`Token: ${fake.jwt()}. Is it valid?`).text).toBe(`Token: ${CREDENTIAL_MARKER}. Is it valid?`)
    const cut = fake.pem().split('\n').slice(0, 3).join('\n')
    expect(redactCredentials(`${cut}\n\nIt stops there, sorry.`).text).toBe(`${CREDENTIAL_MARKER}\n\nIt stops there, sorry.`)
    // As a JSON string (a service account file): escaped newlines, with and without its END line.
    const json = fake.pem('PRIVATE').replaceAll('\n', '\\n')
    expect(redactCredentials(`{"private_key": "${json}\\n", "client_email": "bot@example.test"}`).text)
      .toBe(`{"private_key": "${CREDENTIAL_MARKER}\\n", "client_email": "bot@example.test"}`)
    const cutJson = json.slice(0, json.indexOf('-----END'))
    expect(redactCredentials(`{"private_key": "${cutJson}", "x": 1}`).text).toBe(`{"private_key": "${CREDENTIAL_MARKER}", "x": 1}`)
  })

  it('is stable: redacting redacted text removes nothing more', () => {
    const once = redactCredentials(`a ${fake.jwt()} b password=${fake.password()} c ${fake.pem()}`).text
    expect(redactCredentials(once)).toEqual({ text: once, removed: [] })
  })
})

describe('findCredentials: what it leaves alone', () => {
  const sha = 'a3f1c9e27b5d4f80916e2c3b7a8d9e0f1a2b3c4d'
  const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  const image = `data:image/png;base64,${noise(24_000, B64, 40)}==`
  const corpus = [
    // Commit ids, hashes and identifiers
    sha, `Merged ${sha.slice(0, 7)} into main.`, `commit ${sha}\nAuthor: Fixture <fixture@example.test>`,
    `git cherry-pick ${sha} ${sha.slice(0, 12)}`, `sha256:${sha256}`, `"sha256": "${sha256}"`, `integrity: sha512-${noise(86, B64, 41)}==`,
    `docker pull ghcr.io/example/app@sha256:${sha256}`, '123e4567-e89b-12d3-a456-426614174000', 'request 0b5f9d38-3c1e-4c55-9f1a-1d2e3f4a5b6c failed',
    'ObjectId("64f1a2b3c4d5e6f708192a3b")', '01HF8XKQ4N3T6M9V2B7C5D0E1F', 'stableId swarm-session-7f3a9b2c4d5e6f70', 'sha1-8f14e45fceea167a5a36dedd4bea2543',
    `md5 d41d8cd98f00b204e9800998ecf8427e`, `etag: "W/\\"5f3a9b2c4d5e6f708192a3b4c5d6e7f8\\""`, 'Version 1.4.37 (build 20261024.3)', 'v2.0.0-rc.1+sha.5114f85',
    // URLs, with hashes and ids
    `https://github.com/example/project/commit/${sha}`, `https://github.com/example/project/blob/${sha}/backend/src/app.ts#L10-L24`,
    'https://github.com/example/project/pull/1680#discussion_r1789234561', 'https://cdn.example.test/assets/main.4f9a8b7c6d5e.js?v=3f9a8b7c6d5e4f3a',
    `https://example.test/download?ref=${sha}&page=2`, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
    'https://drive.google.com/file/d/1aBcD3eFgH4iJkL5mNoP6qRsT7uVwX8yZ/view?usp=sharing', 'https://example.test/a/b#section-3.2.1',
    'https://user@example.test/repo.git', 'git@github.com:example/project.git', 'ssh://git@github.com:22/example/project.git',
    'postgres://postgres:postgres@localhost:5432/dev', 'https://hooks.example.test/T000/B000/abc',
    // Base64 data and public keys
    image, `![screenshot](${image})`, noise(4096, B64, 42), noise(4096, B64URL, 43),
    `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${noise(43, B64, 44)} fixture@example.test`, `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ${noise(300, B64, 45)} me@host`,
    ['-----BEGIN PUBLIC KEY-----', noise(64, B64, 46), '-----END PUBLIC KEY-----'].join('\n'),
    ['-----BEGIN CERTIFICATE-----', noise(64, B64, 47), '-----END CERTIFICATE-----'].join('\n'),
    'A PEM file starts with -----BEGIN PRIVATE KEY----- and ends with -----END PRIVATE KEY-----.',
    '-----BEGIN RSA PRIVATE KEY-----\n<paste your key here>\n-----END RSA PRIVATE KEY-----',
    // Long words, dotted names, emails, paths
    'Pneumonoultramicroscopicsilicovolcanoconiosis', 'Supercalifragilisticexpialidocious', 'Donaudampfschifffahrtsgesellschaftskapitän',
    'antidisestablishmentarianism and floccinaucinihilipilification', 'www.example.com', 'api.github.com', 'os.path.join(base, name)', 'a.b.c',
    'the.quick.brown.fox.jumps', 'config.secrets.production.apiKey', 'fixture.person@example.test', '/home/dev/code/project/backend/src/app.ts',
    'C:\\dev\\AppData\\Local\\Harness', '~/.ssh/id_ed25519', 'aGVsbG8gd29ybGQ.d29ybGQgaGVsbG8.Zm9vYmFy', 'eyJub3QiOiJqc29u.x.y',
    // Code that names a secret without holding one
    'const token = process.env.GITHUB_TOKEN', 'const token = await getToken(); headers.Authorization = `Bearer ${token}`',
    'password: z.string().min(12)', 'api_key = os.environ["OPENAI_API_KEY"]', 'export GITHUB_TOKEN=$(gh auth token)',
    'let secret = std::env::var("SECRET").unwrap();', 'let token = uuid::Uuid::new_v4().to_string();', 'if (password === confirmPassword) return',
    'curl -H "Authorization: Bearer $TOKEN" https://api.github.com/user', 'token: ${{ secrets.GITHUB_TOKEN }}', 'private_key_path: ~/.ssh/id_ed25519',
    'access_key: process.env.AWS_ACCESS_KEY_ID', 'max_tokens: 4096', 'max_tokens=128000', 'tokenizer: cl100k_base', '"secret_name": "prod/db/password"',
    'password_hash: $2b$12$abcdefghijklmnopqrstuv', 'secret = SECRET_KEY_V2', 'token: Token | null', 'apiKey: config.apiKey,',
    'refresh_token_expires_in: 15552000', 'publicKeyToken="6595b64144ccf1df"', 'jwt.sign(payload, secret, { expiresIn: "1h" })',
    'def get_secret(name: str) -> str:\n    return vault.read(name)', 'SELECT id, password_reset_at FROM users WHERE token_id = $1',
    'for (const token of tokens) count += token.length', '<input type="password" name="password" autocomplete="current-password">',
    // Placeholders and redacted values
    'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'sk-...', 'sk-your-key-here', 'sk-learn and scikit-learn', 'AKIAXXXXXXXXXXXXXXXX',
    'xoxb-your-token-here', 'password=changeme', 'password: ********', 'token: <redacted>', 'secret=${SECRET}', 'API_KEY=<your key>',
    'password=test-password-123', 'token: e2e-token-agent-client', 'apiKey: gridkey-abc123', `token: ${CREDENTIAL_MARKER}`, 'hna_short',
    'Bearer tokens expire after an hour.', 'Basic authentication is disabled.', 'Authorization: Bearer test-access-token',
    // Prose, in English and Vietnamese
    'Please review PR #1680 before the release; the Lead will merge it once CI is green.',
    'The token budget for this task is 200k; keep the secret sauce simple.',
    'Xin chào, mật khẩu của bạn đã được đổi thành công. Vui lòng đăng nhập lại.',
    'Mã xác thực đã hết hạn; hãy yêu cầu mã mới và đừng chia sẻ nó với ai.',
    'Nhóm sẽ triển khai bản cập nhật vào thứ Hai, sau khi kiểm thử xong trên máy Mac mini.',
    'Tôi đã đẩy nhánh feat/swarm-chat-secrets lên và mở bản nháp PR, nhờ anh xem giúp.',
    'Hôm nay là ngày 24/10/2026; cuộc họp lúc 9:30 sáng ở phòng 302.',
    '| Kind | Count |\n|---|---|\n| JWT | 0 |\n| GitHub | 0 |', '2026-10-24T09:30:00.000Z', '+84 000 000 000',
    'Error: ENOENT: no such file or directory, open \'/tmp/harness/config.json\'\n    at Object.openSync (node:fs:573:3)',
  ]

  it(`finds nothing in ${corpus.length} ordinary texts`, () => {
    for (const text of corpus) expect(findCredentials(text), text.slice(0, 120)).toEqual([])
    expect(findCredentials(corpus.join('\n'))).toEqual([])
    expect(redactCredentials(corpus.join(' ')).removed).toEqual([])
  })

  it('finds nothing hidden by chance in a large base64 image, even with a key-shaped run inside it', () => {
    const inside = `data:image/png;base64,${noise(1000, B64, 48)}${fake.google()}${noise(1000, B64, 49)}${fake.awsKeyId()}${noise(1000, B64, 50)}`
    expect(findCredentials(inside)).toEqual([])
    // A real credential next to the image still goes.
    expect(redactCredentials(`${image} ${fake.github('ghp')}`).text).toBe(`${image} ${CREDENTIAL_MARKER}`)
  })

  it('reads a message at the size limit quickly, whatever it holds', () => {
    for (const text of [noise(32_000, B64URL, 51), 'a'.repeat(32_000), `${'x.'.repeat(16_000)}`, `password=${'A1'.repeat(16_000)}`,
      `${'-----BEGIN PRIVATE KEY-----'.repeat(1000)}`, `https://${'a'.repeat(31_000)}:`]) {
      const started = performance.now()
      findCredentials(text)
      expect(performance.now() - started).toBeLessThan(500)
    }
  })
})

describe('credentialResult', () => {
  it('tells the sender what kind of credential went and to revoke or rotate it', () => {
    expect(credentialResult(['github'])).toEqual({
      credentialsRemoved: [{ kind: 'github', label: 'GitHub token', count: 1 }],
      credentialNotice: 'Removed a credential (GitHub token) before saving. Revoke or rotate it.',
    })
    expect(credentialResult(['jwt', 'github', 'jwt'])).toEqual({
      credentialsRemoved: [{ kind: 'jwt', label: 'JWT', count: 2 }, { kind: 'github', label: 'GitHub token', count: 1 }],
      credentialNotice: 'Removed 3 credentials (JWT, GitHub token) before saving. Revoke or rotate them.',
    })
  })

  it('has a plain label for every kind', () => {
    for (const label of Object.values(CREDENTIAL_LABELS)) expect(label).toMatch(/^[A-Za-z][A-Za-z -]+$/)
  })
})
