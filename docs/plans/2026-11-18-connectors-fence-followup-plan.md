# Connections upload fence: identity, not spelling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(connections): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. No task pushes or merges.

**Goal:** `harness connections call … --form k=@path` refuses a file inside a credential folder however the caller names the file and whatever environment it sets, and sends the bytes of the file it checked.

**Architecture:**
- **The check** (`cli/src/lib/connectors/call.ts`): `uploadFile` replaces `uploadPath`. It opens the file once, checks the open file, walks the folders above its resolved path by `dev`+`ino`, and reads from the same descriptor. The text compare (`inside`, `fenced`) goes. Only the share check (`unc`) stays on text, and nothing on a share is opened to decide.
- **Windows' AppData** (`cli/src/lib/windows/knownFolders.ts`, new): the account's AppData folders from the registry, read by one hidden `cmd.exe` run (its full path) that sets its console to UTF-8 and runs both `reg.exe` queries by their full path, under an environment that names nothing, once per process, only on Windows. A failed read never refuses an upload.
- The CLI process only. No file under `cli/src/core/`, no line in `src/architecture.coreFiles.txt`, no workflow file.

**Tech Stack:** TypeScript on Node 22.15 or later (`node:fs` with `bigint` stats), vitest 4; `cmd.exe`, `chcp.com` and `reg.exe` on Windows.

**Spec:** `docs/plans/2026-11-18-connectors-fence-followup-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` and `docs/windows-rules.md`.

**Open questions:** none. The draft's three were answered by the orchestrator (2026-11-18): "Decided (orchestrator, 2026-11-18)", items 7 to 9.

## Base

- `fix/connectors-fence-followup` at `03a6f95a0e` (`main` after #4442). The spec and this plan are untracked. The main session commits them; no task does.
- At the base, on this Mac: `cd cli && npx vitest run src/lib/connectors/call.spec.ts` is 25 passed, 2 skipped (27).
- Tried on this Mac (2026-11-18, in scratch files since deleted). Against the base: the red tests of Task 1 (the case-folded case) and of Task 2 (the four swap cases) fail today. Against a sketch of the whole change: every test block of Tasks 1 to 5 that runs on macOS passes (33 cases for `call.spec.ts`, 17 for the reader), and both type-check. That sketch read the registry with two direct `reg.exe` runs and opened the file by its `resolve()`d path; item 7 and item 9 below changed both since. No case that runs only on Windows has run anywhere yet.
- The tasks name functions, never lines. If a name differs at the base, the implementer follows the code and says so in its report.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The fence walks the file's folders by identity (gap 3) | `cli/src/lib/connectors/call.ts`, `call.spec.ts` | none | xhigh | `call.spec.ts` |
| 2 One open: the bytes sent are the checked file's (gap 2) | `cli/src/lib/connectors/call.ts`, `call.spec.ts` | 1 | xhigh | `call.spec.ts` |
| 3 No share is read to decide (gap 4) | `cli/src/lib/connectors/call.ts`, `call.spec.ts` | 2 | xhigh | `call.spec.ts` |
| 4 Windows' AppData folders, from the registry | `cli/src/lib/windows/knownFolders.ts`, `knownFolders.spec.ts`, `knownFolders.windows.real.spec.ts` (all new) | none | xhigh | `knownFolders.spec.ts` |
| 5 The registry's AppData fences an upload (gap 1) | `cli/src/lib/connectors/call.ts`, `call.spec.ts` | 3, 4 | xhigh | `call.spec.ts` |

Longest chain: four tasks (1 → 2 → 3 → 5).

- Task 4 shares no file with Tasks 1 to 3 and starts at once, beside them.
- Tasks 1, 2, 3 and 5 share `call.ts` and `call.spec.ts`; each uses what the one before it built (the walk, then `uploadFile` and its hooks, then the folder reader).
- No docs task: no doc describes the fence. No workflow task: `windows.yml` already lists `src/lib/connectors/call.spec.ts` and the whole of `src/lib/windows`.

## Before starting

- `cd cli && npm ci` if `cli/node_modules` is missing (this worktree has it since the planning session).
- Each task runs only its own specs and `npm run typecheck`. Suites run on CI.
- A case that runs only on Windows cannot be seen red on this Mac. It is written with its task, and its first run is the Windows run of "Verification". Each task says which of its cases those are.

## Global Constraints

- **Messages and exit codes stay.** Every refusal is `CallFailure` code 2, with the texts of today: `refusing to upload <raw>: not a media file the helper may send`, `refusing to upload <raw>: only <suffixes> files`, `cannot read upload <raw>`. One text is new, the spec's: `cannot check upload <raw>`.
- **Identity, no text fallback.** A folder holds a file when one of the file's folders, walked from its resolved path to the root, has the folder's `dev` and `ino` (both `bigint`). An `ino` of `0`, on the file or on any folder above it, refuses the upload.
- **The caller shapes the arguments and the environment, never the file system or the registry.** No decision reads `PATH`, `ComSpec`, `SystemRoot`, `windir`, `TEMP` or `TMP`. `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` and `HARNESS_CONNECTIONS_DIR` only ever add forbidden folders.
- **No share is opened, read or looked up to decide.** Every path, the file's and each forbidden folder's, is made absolute before the share check; a forbidden folder on a share is dropped unread. Uploading from a share stays refused.
- **The bytes sent are the bytes of the file that was checked:** one open, the content read from that descriptor, the descriptor closed in every case.
- **No new forbidden folder** but the registry's AppData, and no change to the allowed suffixes.
- **The registry is read only on Windows, only for an upload that reaches the folder check, once per process.** A read that fails falls back to the folders of today and writes one line to stderr with no path. It never refuses an upload.
- **A request with no `@path` upload costs nothing more** than today.
- **Tests never write in the real home** (cli/AGENTS.md rule 6): each uses its own folder under the temporary folder, and the account's home through the spec's `node:os` mock. The real credential folders are only `stat`ed, as #4442 resolved them.
- **Platforms:** Windows, macOS, Linux.
- Comments say why. No dead code: `inside`, `fenced`, `tempDir` and `uploadPath` go with their tests.

## Review Focus

1. **Two files in one command, an empty file, a large one.** Each is read whole from its own descriptor and each descriptor is closed; the registry is read once. Task 2 (`returns the resolved file's name and every byte`, `closes the descriptor whatever the answer`), Task 4 (`reads once in a process`).
2. **A Windows account or folder with letters outside ASCII.** `reg.exe` prints to a pipe in the console's code page (`cli/src/scripts/installPs1.spec.ts`, `userPathValue`), so the `cmd.exe` run sets that code page to UTF-8 first. A wrong spelling must never be taken for a folder: a value still not UTF-8, or holding a `?`, is never taken. Task 4 (`cannot read a value reg.exe printed outside UTF-8`, and the scratch key's `ö` read back on Windows).
3. **Windows in another language.** `reg.exe` translates its own messages, never a key, a value's name or its type. Task 4 (`ignores what reg.exe says around the values`).
4. **A FIFO, a folder or an unreadable file named like a document.** The open must not wait, and the answer is a refusal, not a crash. Task 2 (`never waits on a FIFO named as a document`, `cannot read a file that is not there`, `closes the descriptor whatever the answer`).
5. **A link whose target has another name or suffix** (`pic.png` to `notes.md`, `pic.png` to `id_rsa`). The name sent is the resolved file's, as today, and both names pass the suffix check. Task 2 (`opens nothing that is not named as a media file or document`).

## Decided (orchestrator, 2026-11-18)

All final, in the spec's "Calls made after the builder check":

1. An identity walk of the resolved file's folders replaces `inside` and `fenced`. No text fallback. An `ino` of `0` on the file or a folder above it: `cannot check upload`.
2. Open once (`O_NONBLOCK` on posix), `fstat` the descriptor, `realpathSync.native`, `stat(real)` must be the descriptor's identity, read from the descriptor. `uploadFile` returns `{ name, content }`.
3. The share check stays on text (`unc`), on the absolute path. A forbidden folder on a share is dropped unopened. A link or a mapped drive to a share needs no extra lookup.
4. Temporary folders: `<account home>\AppData\Local\Temp` and, when it exists, `<registry Local AppData>\Temp`.
5. The registry: the values of `AppData` and `Local AppData` in `User Shell Folders` and in `Shell Folders`, all of them fenced. `%USERPROFILE%` is the account's home from `userInfo`; a value with another variable is skipped. `reg.exe` by a fixed system path, never through `PATH` or a variable, once per process, only on Windows when an upload is checked. A failed or timed-out `reg.exe` does not refuse: the folders of today stay fenced, and one line on stderr names the failure with no path.
6. Messages and exit codes unchanged.

Answered on this plan's draft:

7. **How the registry is read: one `cmd.exe` run.** `cmd.exe` at its fixed path in System32 (found as `reg.exe` is: `systemRoot()`, never `PATH` or a variable), `/d /s /c`, sets its console to UTF-8 with `chcp.com 65001`, as `cli/src/lib/uninstall/removal.ts` does, then runs both `reg.exe` queries by their full path. One spawn, any letter read. The Windows real test writes a temporary HKCU key holding a value with `ö`, reads it back through the reader, and deletes the key in `finally`. **If that test is red on the real Windows runner**, the fallback is the draft's two direct `reg.exe` runs, a value not in UTF-8 skipped with the stderr line: Task 4's "Fallback" says the switch.
8. **The temporary folders when the two keys disagree:** `Temp` stays open under every registry `Local AppData` that is fenced, as home's own AppData leaves its `Local\Temp` open.
9. **`resolve()` is used only for the share check, on Windows.** The file is opened, and `realpathSync.native` asked, with the path as given after `~` expansion. On macOS and Linux `docs/jump/../note.txt`, with `jump` a link, names the file the kernel reaches through the link.

## Decided here, where the spec was silent

- **Which text each step gives.** A throw from the open, from `realpathSync.native`, or from the `fstat` or the read of the open descriptor: `cannot read upload <raw>`. Not a regular file, more than one link, a resolved path on a share, a `stat(real)` that fails or is another file, a forbidden folder above it: `… not a media file the helper may send`. A folder above it that cannot be read, or has no number: `cannot check upload <raw>`.
- **The suffix comes first**, as the spec's rule orders it: a missing file with a wrong suffix now says `only … files` where it said `cannot read upload`. No text changes.
- **The walk starts at the file itself** and, at each step, asks "forbidden?" before "temporary?": a forbidden folder that is the temporary folder still fences, as `fenced` answered for `dir === temp`.
- **The share check reads the path as given and its absolute form.** `resolve()` turns `\??\UNC\host\share\x.txt` into a path on the working drive, which would hide it (tried: `C:\??\UNC\host\share\x.txt`). A forbidden folder is read by its absolute path only.
- **The `cmd.exe` run has 3 000 ms**, the bound `readUserEnvironment` gives `reg query` (`cli/src/lib/serviceCommand.ts`), and runs with `env: { SystemRoot: <the system folder found> }` and nothing of the caller's. Its line goes to `cmd.exe` as written (`windowsVerbatimArguments`), as `cli/src/engines/kit/windowsInstall.ts` passes one.
- **Each key's answer is told apart by a marker line** the run echoes after its query: `harness-key-read` when `reg.exe` succeeded, `harness-key-failed` when not. No value line can be one: `reg.exe` indents every value.
- **The system folder** is `realpathSync.native('\\\\?\\GLOBALROOT\\SystemRoot')` when that is a drive's folder whose name `cmd.exe` reads as itself (no `%`, `!`, `"`, `^`, `&`, `|`, `<`, `>`), else `C:\Windows` (the spec's own example).
- **What was read is used.** When one key's query fails, the other key's folders still fence: they only ever add. The failure is said once.
- **The line on stderr:** `upload check: <failure>; a moved AppData folder may not be fenced`, where `<failure>` is `cmd.exe did not start`, `cmd.exe timed out`, `cmd.exe exited <n>`, `reg.exe could not read a key` or `reg.exe printed a folder it could not spell`.
- **The registry is read after the file passed its own checks**, so a refused path costs no process.
- **"Windows only" lives in the reader** (`process.platform`), not in `call.ts`: off Windows it answers no folder and runs nothing. So Task 5's cases run on every platform with the reader mocked.
- **Gap 1 on Windows CI is two proofs, not a moved real profile:** the real reader against the real keys and a scratch key (Task 4), and the upload check with the reader's answer set (Task 5). No test edits the real `User Shell Folders`.
- **Test hooks:** module mocks, as the spec has for `node:os` and `node:path`: `node:fs` (Task 1) and `../windows/knownFolders.js` (Task 5).

---

### Task 1: The fence walks the file's folders by identity (gap 3)

**Depends on:** none. **Effort:** `xhigh` (it replaces what decides "inside a credential folder").

**Red test:** `cli/src/lib/connectors/call.spec.ts`.

**Files:**
- Modify: `cli/src/lib/connectors/call.ts` (`inside` and `fenced` removed; `Identity`, `Verdict`, `identity`, `identities`, `walk` added; `uploadPath`)
- Test: `cli/src/lib/connectors/call.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Identity { dev: bigint, ino: bigint }
  export type Verdict = 'open' | 'fenced' | 'unknown'
  /** `statSync(path, { bigint: true })`'s dev and ino, following links; undefined when it cannot be read. */
  export function identity(path: string): Identity | undefined
  /** Each folder's identity; one not named, or that cannot be read, is skipped. */
  export function identities(dirs: (string | undefined)[], identify: (path: string) => Identity | undefined = identity): Identity[]
  export function walk(real: string, identify: (path: string) => Identity | undefined, forbidden: Identity[], temps: Identity[],
    p: PlatformPath = platformPath): Verdict
  ```
  - `walk` goes from `real` itself up by `p.dirname` until the root (`p.dirname(path) === path`). At each step, in this order: no identity, or `ino === 0n`: `'unknown'`; one of `forbidden`: `'fenced'`; one of `temps`, or the root: `'open'`.
  - `identity` reads only `dev` and `ino` of what `statSync` answers.
- The spec's hooks, which Tasks 2, 3 and 5 use as they are:
  ```ts
  // The file system calls the upload check makes. A test that sets `disk.hooks.<name>` is handed the real call and its
  // arguments, and answers for it; unset, the real call runs.
  type Hook = (real: (...args: never[]) => unknown, ...args: never[]) => unknown
  const disk = vi.hoisted(() => ({ hooks: {} as Record<string, Hook | undefined> }))
  vi.mock('node:fs', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs')>()
    const hooked = (name: 'openSync' | 'fstatSync' | 'statSync' | 'readFileSync' | 'closeSync') => (...args: never[]): unknown => {
      const real = fs[name] as (...args: never[]) => unknown
      return disk.hooks[name] ? disk.hooks[name]!(real, ...args) : real(...args)
    }
    return { ...fs, openSync: hooked('openSync'), fstatSync: hooked('fstatSync'), statSync: hooked('statSync'), readFileSync: hooked('readFileSync'), closeSync: hooked('closeSync') }
  })
  ```
  `afterEach` gains `disk.hooks = {}`. `vi.spyOn(realpathSync, 'native')` keeps working: the mock hands on the same function.
  ```ts
  /** A disk for the walk: every path is a folder of its own; `same` lists spellings of one folder, `unread` paths that cannot be read. */
  function tree(same: string[][] = [], unread: string[] = []): (path: string) => Identity | undefined {
    const numbers = new Map<string, bigint>()
    const folder = (path: string): string => same.find(spellings => spellings.includes(path))?.[0] ?? path
    return path => {
      if (unread.includes(path)) return undefined
      if (!numbers.has(folder(path))) numbers.set(folder(path), BigInt(numbers.size + 1))
      return { dev: 1n, ino: numbers.get(folder(path))! }
    }
  }
  ```

- [ ] **Step 1: Write the failing tests.** Remove `describe('inside')` and `describe('fenced')`. Add:
  ```ts
  describe('walk', () => {
    const a = 'C:\\Users\\a'
    const temp = `${a}\\AppData\\Local\\Temp`
    const appData = [`${a}\\AppData`, `${a}\\AppData\\Roaming`, `${a}\\AppData\\Local`]
    const verdict = (file: string, forbidden: string[], temps: string[] = [], on = tree()): Verdict =>
      walk(file, on, forbidden.map(dir => on(dir)!), temps.map(dir => on(dir)!), win32)

    it('fences a file under a forbidden folder, at any depth, and the folder itself', () => {
      for (const file of [`${a}\\.ssh\\id.txt`, `${a}\\.ssh\\keys\\old\\id.txt`, `${a}\\.ssh`]) expect(verdict(file, [`${a}\\.ssh`]), file).toBe('fenced')
      for (const file of [`${a}\\.sshx\\f.txt`, `${a}\\f.txt`, 'C:\\f.txt', 'D:\\Users\\a\\.ssh\\f.txt']) expect(verdict(file, [`${a}\\.ssh`]), file).toBe('open')
    })
    it('fences by the folder, not by how its path is spelled', () => {
      const on = tree([[`${a}\\.ssh`, `${a}\\.SSH`, `${a}\\SSH~1`, 'X:\\.ssh', `\\\\?\\${a}\\.ssh`]])
      for (const file of [`${a}\\.SSH\\id.txt`, `${a}\\SSH~1\\id.txt`, 'X:\\.ssh\\id.txt', `\\\\?\\${a}\\.ssh\\id.txt`]) expect(verdict(file, [`${a}\\.ssh`], [], on), file).toBe('fenced')
    })
    it('tells two folders with one number apart by their device', () => {
      const on = (path: string): Identity => ({ dev: path.startsWith('D:') ? 2n : 1n, ino: 7n })
      expect(walk('C:\\x\\f.txt', on, [{ dev: 1n, ino: 7n }], [], win32)).toBe('fenced')
      expect(walk('D:\\x\\f.txt', on, [{ dev: 1n, ino: 7n }], [], win32)).toBe('open')
    })
    it('leaves the temporary folder open under AppData, but for a forbidden folder inside it or one that is it', () => {
      for (const file of [`${temp}\\x.txt`, `${temp}\\docs\\x.txt`]) expect(verdict(file, appData, [temp]), file).toBe('open')
      for (const file of [`${a}\\AppData\\Roaming\\x.txt`, `${a}\\AppData\\Local\\Foo\\x.txt`, `${a}\\AppData\\LocalLow\\Temp\\x.txt`, `${a}\\AppData\\Local\\Tempx\\x.txt`]) {
        expect(verdict(file, appData, [temp]), file).toBe('fenced')
      }
      expect(verdict(`${temp}\\h\\.ssh\\id.txt`, [...appData, `${temp}\\h\\.ssh`], [temp])).toBe('fenced')
      expect(verdict(`${temp}\\h\\AppData\\Roaming\\x.txt`, [...appData, `${temp}\\h\\AppData`], [temp])).toBe('fenced')
      expect(verdict(`${temp}\\x.txt`, [...appData, temp], [temp])).toBe('fenced')
    })
    it('cannot tell under a folder it cannot read or one with no number, the file\'s own too', () => {
      expect(walk('/home/a/docs/x.txt', tree([], ['/home']), [], [], posix)).toBe('unknown')
      for (const numberless of ['/home/a/docs/x.txt', '/home/a', '/']) {
        expect(walk('/home/a/docs/x.txt', path => ({ dev: 1n, ino: path === numberless ? 0n : 9n }), [], [], posix), numberless).toBe('unknown')
      }
    })
    it('walks a posix path to the root', () => {
      const on = tree()
      const ssh = [on('/home/a/.ssh')!]
      expect(walk('/home/a/.ssh/id.txt', on, ssh, [], posix)).toBe('fenced')
      for (const file of ['/home/a/docs/x.txt', '/x.txt']) expect(walk(file, on, ssh, [], posix), file).toBe('open')
    })
  })

  describe('identities', () => {
    it('is each folder\'s identity, without the ones not named or not there', () => {
      const on = (path: string): Identity | undefined => path === '/missing' ? undefined : { dev: 1n, ino: BigInt(path.length) }
      expect(identities(['/a', undefined, '/missing', '/bcd'], on)).toEqual([{ dev: 1n, ino: 2n }, { dev: 1n, ino: 4n }])
    })
  })
  ```
  `describe('tempDir')` keeps what `describe('fenced')` said of it: `tempDir('C:\\Users\\a', win32)` is `C:\Users\a\AppData\Local\Temp`; `tempDir('/home/a', posix)` and `tempDir(undefined, win32)` are `undefined`.
  In `describe('uploadPath')`:
  ```ts
  it('reads a folder\'s identity from the disk, through a link too', () => {
    const ssh = statSync(join(home, '.ssh'), { bigint: true })
    expect(identity(join(home, '.ssh'))).toEqual({ dev: ssh.dev, ino: ssh.ino })
    expect(identity(join(home, 'none'))).toBeUndefined()
    symlinkSync(join(home, '.ssh'), join(home, 'keys'), 'junction')
    expect(identity(join(home, 'keys'))).toEqual(identity(join(home, '.ssh')))
  })
  // Linux keeps the spelling given in a case-folded folder. Here realpath is made to, on a disk that folds case.
  it('refuses it in a folder whose spelling the file system did not correct, as a case-folded folder on Linux', ctx => {
    if (!existsSync(join(home, '.SSH', 'note.txt'))) ctx.skip()
    vi.spyOn(realpathSync, 'native').mockImplementation(path => String(path))
    expectFenced(join(home, '.SSH', 'note.txt'))
  })
  it('cannot check an upload under a folder with no number', () => {
    disk.hooks.statSync = (real, ...args) => {
      const [path, options] = args as unknown as [string, { bigint?: boolean } | undefined]
      const stat = real(...args) as { dev: bigint, ino: bigint }
      return path === home && options?.bigint ? { dev: stat.dev, ino: 0n } : stat
    }
    const file = join(home, 'docs', 'note.txt')
    expect(refused(file)).toMatchObject({ code: 2, message: `cannot check upload ${file}` })
  })
  ```
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/connectors/call.spec.ts`. Expected: FAIL (`walk`, `identity` and `identities` are not functions; on this Mac `refuses it in a folder whose spelling…` returns the path; `cannot check…` returns the path). Every other case passes.
- [ ] **Step 3: Implement.** In `uploadPath`, after `real`: a share (`unc(real)`) is refused first, so no folder of a share is read. Then `walk(real, identity, identities(forbiddenDirs(env, [homedir(), account])), identities([tempDir(account)]))`: `'unknown'` throws `CallFailure(2, \`cannot check upload ${raw}\`)`, `'fenced'` refuses as today. The regular-file, hard-link and suffix checks stay. The `native` helper and the `resolve` import go. `walk`'s comment says why identity (case, 8.3 names, `\\?\`, `subst`, links and case-folded folders reach one identity) and why forbidden is asked before temporary.
- [ ] **Step 4: Run** the step 2 command and `npm run typecheck`. Expected: PASS; on this Mac the case-folded case ran (it is skipped only on a case-sensitive disk).
- [ ] **Step 5: Commit** `Connections: an @path upload is fenced by its folders' identity, not their spelling`.

---

### Task 2: One open: the bytes sent are the checked file's (gap 2)

**Depends on:** Task 1. **Effort:** `xhigh` (a check-then-read race).

**Red test:** `cli/src/lib/connectors/call.spec.ts`.

**Files:**
- Modify: `cli/src/lib/connectors/call.ts` (`uploadPath` becomes `uploadFile`; `multipart`)
- Test: `cli/src/lib/connectors/call.spec.ts`

**Interfaces:**
- Consumes: Task 1's `identity`, `identities`, `walk`, `disk.hooks`.
- Produces:
  ```ts
  /** An `@path` upload: plain media or a document, never from where credentials or configs live. The bytes are read from the descriptor that was checked. */
  export function uploadFile(raw: string, env: NodeJS.ProcessEnv = process.env): { name: string, content: Buffer }
  ```
  `multipart` uses `name` and `content`; nothing reads the path by name after the check. `uploadPath` is gone.
- The spec's helpers, which Tasks 3 and 5 use:
  ```ts
  /** Whether this account can make a file link: Windows needs a right for it, which CI's runner has. */
  const CAN_LINK = ((): boolean => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-link-'))
    try { writeFileSync(join(dir, 'a'), ''); symlinkSync(join(dir, 'a'), join(dir, 'b')); return true } catch { return false } finally { rmSync(dir, { recursive: true, force: true }) }
  })()
  /** What one upload answers: 'sent', or the refusal's text. */
  const said = (raw: string, env: NodeJS.ProcessEnv = { HOME: home }): string => { try { uploadFile(raw, env); return 'sent' } catch (error) { return (error as Error).message } }
  /** From here on: the paths an open was tried on, the descriptors opened, and the ones closed. */
  const descriptors = (): { tried: unknown[], opened: unknown[], closed: unknown[] } => {
    const tried: unknown[] = [], opened: unknown[] = [], closed: unknown[] = []
    disk.hooks.openSync = (real, ...args) => { tried.push((args as unknown[])[0]); const fd = real(...args); opened.push(fd); return fd }
    disk.hooks.closeSync = (real, ...args) => { closed.push((args as unknown[])[0]); return real(...args) }
    return { tried, opened, closed }
  }
  /** One request through `call` as far as `fetch`: the body it would send, and what it wrote to stderr in `err`. */
  async function sent(args: string[], err: string[] = [], env: NodeJS.ProcessEnv = { HOME: home }): Promise<string> {
    let body = ''
    vi.stubGlobal('fetch', async (_url: URL, init: { body?: Buffer | string }) => { body = Buffer.from(init.body ?? '').toString('latin1'); return new Response('{}') })
    const vault = { root: home, token: () => ({ access_token: 't', source: 'gateway' }) } as unknown as Store
    await call(vault, 'slack', 'POST', 'https://slack.com/api/files.upload', args, { out: () => undefined, err: line => { err.push(line) } }, env)
    return body
  }
  ```
  `afterEach` gains `vi.unstubAllGlobals()`. The vault is a stub: the real `Store` assumes posix permissions, and this spec runs on Windows.

- [ ] **Step 1: Write the failing tests.** Rename `describe('uploadPath')` to `describe('uploadFile')`; `refused` and every earlier case call `uploadFile`. `allows a document elsewhere, also written from ~/` becomes the second case below. `refuses a share path on Windows before it resolves it…` also sets `descriptors()` and expects `tried` to be `[]`.
  ```ts
  // The path is swapped for a link into .ssh as the named call about the file runs: before the open, between the
  // open and each check, and before the read.
  it.skipIf(!CAN_LINK).each(['openSync', 'fstatSync', 'statSync', 'readFileSync'] as const)('never sends the file its path was swapped for as %s runs', async name => {
    const file = join(home, 'docs', 'note.txt')
    writeFileSync(file, 'checked')
    writeFileSync(join(home, '.ssh', 'note.txt'), 'secret')
    let swapped = false
    disk.hooks[name] = (real, ...args) => {
      const first = (args as unknown[])[0]
      if (!swapped && (first === file || (typeof first === 'number' && first > 2))) {
        swapped = true
        renameSync(file, `${file}.moved`)
        symlinkSync(join(home, '.ssh', 'note.txt'), file)
      }
      return real(...args)
    }
    const body = await sent(['--form', `file=@${file}`]).catch((error: unknown) => { expect(error).toMatchObject({ code: 2 }); return '' })
    expect(swapped).toBe(true)
    expect(body).not.toContain('secret')
    if (body) expect(body).toContain('\r\n\r\nchecked\r\n')
  })

  it('returns the resolved file\'s name and every byte, read from the descriptor it checked', async () => {
    const doc = join(home, 'docs', 'note.txt')
    expect(uploadFile(doc, { HOME: home })).toEqual({ name: 'note.txt', content: Buffer.from('x') })
    expect(uploadFile('~/docs/note.txt', { HOME: home })).toEqual({ name: 'note.txt', content: Buffer.from('x') })
    writeFileSync(join(home, 'docs', 'empty.txt'), '')
    expect(uploadFile(join(home, 'docs', 'empty.txt'), { HOME: home }).content.length).toBe(0)
    const large = Buffer.alloc(1 << 20, 7)
    writeFileSync(join(home, 'docs', 'large.png'), large)
    expect(uploadFile(join(home, 'docs', 'large.png'), { HOME: home }).content.equals(large)).toBe(true)
    // Two files in one command: each part carries its own file's name and bytes.
    const body = await sent(['--form', `a=@${doc}`, '--form', `b=@${join(home, 'docs', 'empty.txt')}`, '--form', 'title=t'])
    expect(body).toContain('name="a"; filename="note.txt"\r\nContent-Type: application/octet-stream\r\n\r\nx\r\n')
    expect(body).toContain('name="b"; filename="empty.txt"\r\nContent-Type: application/octet-stream\r\n\r\n\r\n')
  })

  it('closes the descriptor whatever the answer', () => {
    linkSync(join(home, '.ssh', 'note.txt'), join(home, 'docs', 'link.txt'))
    mkdirSync(join(home, 'docs', 'dir.txt'))
    for (const [file, answer] of [['docs/note.txt', /^sent$/], ['.ssh/note.txt', /not a media file/], ['docs/link.txt', /not a media file/], ['docs/dir.txt', /not a media file/]] as const) {
      const { opened, closed } = descriptors()
      expect(said(join(home, file)), file).toMatch(answer)
      expect(opened.length, file).toBe(1)
      expect(closed, file).toEqual(opened)
    }
  })

  // An open for reading waits for a FIFO's writer; with O_NONBLOCK it returns at once.
  it.skipIf(process.platform === 'win32')('never waits on a FIFO named as a document', () => {
    execFileSync('mkfifo', [join(home, 'docs', 'pipe.txt')])
    const { opened, closed } = descriptors()
    expect(said(join(home, 'docs', 'pipe.txt'))).toMatch(/not a media file/)
    expect(closed).toEqual(opened)
  }, 5_000)

  it('cannot read a file that is not there, or one this account may not open', () => {
    const missing = join(home, 'docs', 'none.txt')
    expect(said(missing)).toBe(`cannot read upload ${missing}`)
    // Windows has no such mode bits, and root opens anything.
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    writeFileSync(join(home, 'docs', 'locked.txt'), 'x')
    chmodSync(join(home, 'docs', 'locked.txt'), 0)
    expect(said(join(home, 'docs', 'locked.txt'))).toBe(`cannot read upload ${join(home, 'docs', 'locked.txt')}`)
  })

  it('opens nothing that is not named as a media file or document, and checks the resolved name too', ctx => {
    writeFileSync(join(home, 'docs', 'note.exe'), 'x')
    const { tried, opened, closed } = descriptors()
    expect(said(join(home, 'docs', 'note.exe'))).toMatch(/only .* files$/)
    expect(said(join(home, 'docs', 'none.exe'))).toMatch(/only .* files$/)
    expect(tried).toEqual([])
    if (!CAN_LINK) ctx.skip()
    writeFileSync(join(home, 'docs', 'id_rsa'), 'x')
    symlinkSync(join(home, 'docs', 'id_rsa'), join(home, 'docs', 'pic.png'))
    expect(said(join(home, 'docs', 'pic.png'))).toMatch(/only .* files$/)
    symlinkSync(join(home, 'docs', 'note.txt'), join(home, 'docs', 'alias.md'))
    expect(uploadFile(join(home, 'docs', 'alias.md'), { HOME: home }).name).toBe('note.txt')
    expect(closed).toEqual(opened)
  })
  ```
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/connectors/call.spec.ts`. Expected: FAIL. The four swap cases: `statSync` and `readFileSync` send `secret`; `openSync` and `fstatSync` never swap (`expected false to be true`). The cases that call `uploadFile`: `uploadFile is not a function`.
- [ ] **Step 3: Implement `uploadFile`,** in this order. Path calls go through `platformPath` (`extname`, `basename`): the spec's `node:path` mock swaps only the default import.
  1. `given = expandHome(raw, env.HOME || homedir())`. A share (`unc(given)`): refused. Making it absolute is Task 3's, with its red test.
  2. The suffix of `given`, else `only … files`. Nothing is opened before this.
  3. `openSync(given, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))`: Windows has no `O_NONBLOCK`. A throw: `cannot read upload`. From here a `finally` closes the descriptor.
  4. `fstatSync(fd, { bigint: true })`: not `isFile()`, or `nlink > 1n`: refused.
  5. `real = realpathSync.native(given)`; a throw: `cannot read upload`. `unc(real)`: refused. The suffix of `real`, else `only … files`. `identity(real)` missing, or not the descriptor's `dev` and `ino`: refused (the path moved).
  6. Task 1's folder check on `real`: `'unknown'` is `cannot check upload`, `'fenced'` refused.
  7. `{ name: platformPath.basename(real), content: readFileSync(fd) }`; a throw from the read: `cannot read upload`.

  The comment says what is guaranteed and what is not, as the spec's non-goals do: the bytes are the checked file's; a writer that renames the credential folders themselves is out of scope.
- [ ] **Step 4: Run** the step 2 command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Connections: an @path upload is opened once, and the bytes sent are the checked file's`.

---

### Task 3: No share is read to decide (gap 4)

**Depends on:** Task 2. **Effort:** `xhigh` (what the fence opens on the caller's word).

**Red test:** `cli/src/lib/connectors/call.spec.ts`.

**Files:**
- Modify: `cli/src/lib/connectors/call.ts` (`identities`, step 1 of `uploadFile`)
- Test: `cli/src/lib/connectors/call.spec.ts`

**Interfaces:**
- Consumes: Task 1's `identities` and `disk.hooks`; Task 2's `uploadFile`, `said`, `descriptors`.
- Produces:
  ```ts
  /** Each folder's identity, read by its absolute path; one on a share is dropped unread, one not named or not there skipped. */
  export function identities(dirs: (string | undefined)[], identify: (path: string) => Identity | undefined = identity,
    p: PlatformPath = platformPath): Identity[]
  ```
  In `uploadFile`, step 1 becomes: `unc(given) || unc(platformPath.resolve(given))`: refused. The `resolve()`d text serves this check only, and decides only on Windows (`unc` is `false` on posix). Every later step (the suffix, the open, `realpathSync.native`) uses `given`, the path as given after `~` expansion (decided, item 9).

- [ ] **Step 1: Write the failing tests.** Task 1's `identities` case passes `posix` as its third argument. Add to `describe('identities')`:
  ```ts
  it('reads no folder on a share, nor one a working folder on a share makes of a relative name', () => {
    const asked: string[] = []
    const on = (path: string): Identity => { asked.push(path); return { dev: 1n, ino: 1n } }
    const shares = ['\\\\host\\share\\h\\.ssh', '//host/share/roaming', '\\\\?\\UNC\\host\\share\\c', '\\\\.\\UNC\\host\\share\\d', '\\??\\UNC\\host\\share\\e']
    expect(identities([...shares, 'C:\\Users\\a\\.ssh', undefined], on, win32)).toEqual([{ dev: 1n, ino: 1n }])
    expect(asked).toEqual(['C:\\Users\\a\\.ssh'])
    vi.spyOn(process, 'cwd').mockReturnValue('\\\\host\\share\\work')
    expect(identities(['connections', '/etc'], on, win32)).toEqual([])
    expect(asked).toEqual(['C:\\Users\\a\\.ssh'])
  })
  ```
  To `describe('uploadFile')`:
  ```ts
  it('refuses a relative path from a working folder on a share before it opens it', () => {
    platform.windows = true
    vi.spyOn(process, 'cwd').mockReturnValue('\\\\host\\share\\work')
    const realpath = vi.spyOn(realpathSync, 'native')
    const { tried } = descriptors()
    for (const raw of ['x.txt', 'docs\\x.txt', '/x.txt']) expectFenced(raw)
    expect(tried).toEqual([])
    expect(realpath).not.toHaveBeenCalled()
  })

  // The file is opened by the path as given: a `..` after a link goes up from the link's target, as the kernel goes.
  // `resolve()` would drop the link and name docs/note.txt. Windows itself takes `..` off the text before it opens.
  it.skipIf(!CAN_LINK || process.platform === 'win32')('opens the file the kernel reaches through a link, not the one its text names', () => {
    mkdirSync(join(home, 'other', 'inner'), { recursive: true })
    writeFileSync(join(home, 'other', 'note.txt'), 'through the link')
    symlinkSync(join(home, 'other', 'inner'), join(home, 'docs', 'jump'))
    expect(uploadFile(`${home}/docs/jump/../note.txt`, { HOME: home })).toEqual({ name: 'note.txt', content: Buffer.from('through the link') })
  })

  // A name that is never looked up: reading a folder there would wait on the network, and a real share would be connected to.
  it.skipIf(process.platform !== 'win32')('reads no forbidden folder on a share', () => {
    const asked: string[] = []
    disk.hooks.statSync = (real, ...args) => { asked.push(String((args as unknown[])[0])); return real(...args) }
    const realpath = vi.spyOn(realpathSync, 'native')
    const share = '\\\\harness-no-such-host.invalid\\share'
    const env = { HOME: home, USERPROFILE: `${share}\\profile`, APPDATA: `${share}\\Roaming`, LOCALAPPDATA: `${share}\\Local`, HARNESS_CONNECTIONS_DIR: `${share}\\connections` }
    expect(uploadFile(join(home, 'docs', 'note.txt'), env).content.toString()).toBe('x')
    for (const path of [...asked, ...realpath.mock.calls.map(call => String(call[0]))]) expect(unc(path), path).toBe(false)
  })

  // `subst` makes a drive of a folder, with no rights: another name for .ssh that only the file system knows.
  it.skipIf(process.platform !== 'win32')('refuses a file in .ssh reached through a subst drive, and takes a document through it', ctx => {
    const letter = [...'ZYXWVUTSRQP'].find(letter => !existsSync(`${letter}:\\`))
    if (!letter) ctx.skip()
    execFileSync('subst', [`${letter}:`, home])
    try {
      expectFenced(`${letter}:\\.ssh\\note.txt`)
      expect(uploadFile(`${letter}:\\docs\\note.txt`, { HOME: home })).toEqual({ name: 'note.txt', content: Buffer.from('x') })
      // A forbidden folder named through the drive fences the folder itself.
      expect(() => uploadFile(join(home, '.harness', 'note.txt'), { HOME: `${letter}:\\` })).toThrow(/not a media file/)
    } finally { execFileSync('subst', [`${letter}:`, '/d']) }
  })
  ```
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/connectors/call.spec.ts`. Expected: FAIL on this Mac in two cases: `reads no folder on a share…` (the shares are asked) and `refuses a relative path…` (an open of `x.txt` is tried, and the answer is `cannot read upload`). `opens the file the kernel reaches through a link…` passes before and after: it holds decided item 9, so no `resolve()` reaches the open. The two Windows cases are skipped here: `reads no forbidden folder on a share` is red on Windows before step 3; the `subst` case holds what #4442's resolve already caught and identity now carries.
- [ ] **Step 3: Implement.** In `identities`, for each named folder: `path = p.resolve(dir)`; `unc(dir, p) || unc(path, p)`: dropped; else `identify(path)`. In `uploadFile`, step 1 as in "Interfaces". The comment says why both spellings are checked (`resolve()` turns `\??\UNC\…` into a path on the working drive), why a forbidden folder is read by its absolute path, and why the file is opened by the path as given (the kernel's reading of a `..` after a link, not the text's).
- [ ] **Step 4: Run** the step 2 command and `npm run typecheck`. Expected: PASS; every #4442 case still passes (`refuses a share path on Windows before it resolves it, one ~ names too`).
- [ ] **Step 5: Commit** `Connections: the upload fence reads no folder on a share, and sees a share behind a relative path`.

---

### Task 4: Windows' AppData folders, from the registry

**Depends on:** none. **Effort:** `xhigh` (it starts a program and reads system state for a security check).

**Red test:** `cli/src/lib/windows/knownFolders.spec.ts`.

**Files:**
- Create: `cli/src/lib/windows/knownFolders.ts`
- Test: `cli/src/lib/windows/knownFolders.spec.ts` (every platform), `cli/src/lib/windows/knownFolders.windows.real.spec.ts` (Windows only: the real `cmd.exe`, `reg.exe` and registry)

**Interfaces:**
- Produces (decided, item 7):
  ```ts
  export const KNOWN_FOLDERS_TIMEOUT_MS = 3_000
  export const USER_SHELL_FOLDERS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'
  export const SHELL_FOLDERS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders'
  export interface AppDataFolders { roaming: string[], local: string[] }
  /** Its message names what failed, with no path: 'cmd.exe did not start', 'cmd.exe timed out', 'cmd.exe exited <n>', 'reg.exe could not read a key'. */
  export class RegFailure extends Error {}
  export type RegRun = (file: string, args: string[], options: { env: NodeJS.ProcessEnv, timeout: number, windowsHide: true,
    windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'ignore'] }) => { status: number | null, stdout: Buffer, error?: Error }
  /** Each key's values as reg.exe printed them, or why that key could not be read, in the order asked. */
  export type RegQuery = (keys: string[]) => (Buffer | RegFailure)[]

  /** Windows' own folder, asked of the file system: no variable names it. */
  export function systemRoot(real: (path: string) => string = realpathSync.native): string
  /** Every key in one hidden cmd.exe run whose console is UTF-8. Never throws. */
  export function regQuery(keys: string[], run: RegRun = spawnSync): (Buffer | RegFailure)[]
  /** `AppData` and `Local AppData` in one key's output, as written; `unreadable` when reg.exe could not spell one of them. */
  export function folderValues(stdout: Buffer): { roaming?: string, local?: string, unreadable: { roaming: boolean, local: boolean } }
  /** A value with `%USERPROFILE%` as `home`; undefined when it is empty, needs a home there is none of, or holds another variable. */
  export function expandFolder(value: string, home: string | undefined): string | undefined
  /** Both keys' folders, `User Shell Folders` first, each once; `failure` names the first thing that could not be read. */
  export function readAppDataFolders(home: string | undefined, query: RegQuery = regQuery): AppDataFolders & { failure?: string }
  /** The same, read once in this process and only on Windows; `failed` hears a failure once, as that read is made. */
  export function appDataFolders(home: string | undefined, failed: (failure: string) => void,
    read: (home: string | undefined) => AppDataFolders & { failure?: string } = readAppDataFolders, platform: NodeJS.Platform = process.platform): AppDataFolders
  ```
  - `systemRoot`: `real('\\\\?\\GLOBALROOT\\SystemRoot')` when it answers a drive's folder whose name `cmd.exe` reads as itself (`/^[A-Za-z]:\\[^%!"^&|<>]*$/`); a throw or anything else: `C:\Windows`.
  - `regQuery`, with `root = systemRoot()` and `tool = name => win32.join(root, 'System32', name)`: the line is `"<chcp.com>" 65001 >nul`, then for each key ` & ("<reg.exe>" query "<key>" && echo harness-key-read || echo harness-key-failed)`, each tool by `tool(…)`. It runs `tool('cmd.exe')` with `['/d', '/s', '/c', `"${line}"`]` and `{ env: { SystemRoot: root }, timeout: KNOWN_FOLDERS_TIMEOUT_MS, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'ignore'] }`, as `cli/src/engines/kit/windowsInstall.ts` passes a line to `cmd.exe`. The keys are this module's or a test's: none holds `"`, `%` or `!`.
    - The run's own failure is every key's: an `error` whose `code` is `ETIMEDOUT`: `cmd.exe timed out`; another `error`: `cmd.exe did not start`; a status other than 0: `cmd.exe exited <status>`.
    - Else `stdout` is cut at each line that is a marker (its `\r` aside), in order: the bytes before a `harness-key-read` line are that key's; a `harness-key-failed` line, or no marker left for a key, is `reg.exe could not read a key`.
  - `folderValues` takes a line `<spaces>AppData<spaces>REG_SZ|REG_EXPAND_SZ<spaces><data>` or `…Local AppData…`, the name in any case, and no other line. The data's bytes are taken when they are UTF-8 and hold no `?` (what `reg.exe` prints for a letter its code page lacks; no folder's name holds one); else that folder is `unreadable`. With the console in UTF-8 this guard should never fire; it keeps a wrong spelling from ever being taken for a folder.
  - `expandFolder` replaces `%USERPROFILE%` in any case; a `%name%` left after that skips the value. A lone `%` is a name's.
  - `readAppDataFolders` asks `[USER_SHELL_FOLDERS, SHELL_FOLDERS]` in one `query`. A `RegFailure` for one key leaves the other's folders. `failure` is the first `RegFailure`'s message, else `reg.exe printed a folder it could not spell` when a folder was `unreadable` and `User Shell Folders` gave that folder nothing usable.
  - `appDataFolders` off `win32` answers `{ roaming: [], local: [] }` and reads nothing.

- [ ] **Step 1: Write the failing tests** in `knownFolders.spec.ts`:
  ```ts
  const EXPLORER = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer'
  const home = 'C:\\Users\\a'
  /** A key's values as reg.exe prints them: a blank line, the key, each value indented by four spaces. */
  const printed = (key: string, ...values: [name: string, type: string, data: string | Buffer][]): Buffer => Buffer.concat([
    Buffer.from(`\r\n${EXPLORER}\\${key}\r\n`),
    ...values.flatMap(([name, type, data]) => [Buffer.from(`    ${name}    ${type}    `), Buffer.from(data), Buffer.from('\r\n')]), Buffer.from('\r\n')])
  const user = (roaming: string | Buffer = '%USERPROFILE%\\AppData\\Roaming', local: string | Buffer = '%USERPROFILE%\\AppData\\Local'): Buffer =>
    printed('User Shell Folders', ['AppData', 'REG_EXPAND_SZ', roaming], ['Desktop', 'REG_EXPAND_SZ', '%USERPROFILE%\\Desktop'], ['Local AppData', 'REG_EXPAND_SZ', local])
  const shell = (roaming: string | Buffer = `${home}\\AppData\\Roaming`, local: string | Buffer = `${home}\\AppData\\Local`): Buffer =>
    printed('Shell Folders', ['AppData', 'REG_SZ', roaming], ['Local AppData', 'REG_SZ', local])
  /** A registry that answers `first` for User Shell Folders and `second` for Shell Folders; `asked` holds each run's keys. */
  const keys = (first: Buffer | RegFailure, second: Buffer | RegFailure): RegQuery & { asked: string[][] } => {
    const asked: string[][] = []
    return Object.assign((list: string[]) => { asked.push(list); return list.map(key => key === USER_SHELL_FOLDERS ? first : second) }, { asked })
  }
  /** `ö` as code page 437 prints it: one byte, not UTF-8. */
  const OEM = Buffer.concat([Buffer.from('D:\\Redirect '), Buffer.from([0x94]), Buffer.from('\\Roaming')])
  const S32 = 'C:\\Windows\\System32'
  ```
  - `describe('systemRoot')`:
    - `is where \\?\GLOBALROOT\SystemRoot leads, asked of the file system`: `systemRoot(path => { asked.push(path); return 'D:\\Windows' })` is `D:\Windows`; `asked` is `['\\\\?\\GLOBALROOT\\SystemRoot']`.
    - `is C:\Windows when that does not resolve to a drive's folder, whatever the environment says`: with `vi.stubEnv('SystemRoot', 'Z:\\evil')` and `vi.stubEnv('windir', 'Z:\\evil')`, a resolver that throws, one that answers `\\\\server\\share\\Windows`, and one that answers `\\\\?\\GLOBALROOT\\Device\\X` each give `C:\Windows`.
    - `is C:\Windows when cmd.exe would read the folder's name as something else`: `D:\Win%OS%`, `D:\a!b`, `D:\a&b` and `D:\a"b` each give `C:\Windows`.
  - `describe('regQuery')`, where this Mac's `systemRoot()` is `C:\Windows` (the GLOBALROOT path does not resolve here):
    - `runs one hidden cmd.exe from the system folder, its console in UTF-8, bounded, with nothing of this process's environment`: with `PATH`, `SystemRoot` and `ComSpec` stubbed to `Z:\evil`, and `run = vi.fn<RegRun>(() => ({ status: 0, stdout: Buffer.from('a\r\nharness-key-read\r\nb\r\nharness-key-read\r\n') }))`, `regQuery([USER_SHELL_FOLDERS, SHELL_FOLDERS], run)` is `[Buffer.from('a\r\n'), Buffer.from('b\r\n')]`. `run` was called once, with `${S32}\cmd.exe`, `['/d', '/s', '/c', `"\"${S32}\\chcp.com\" 65001 >nul & (\"${S32}\\reg.exe\" query \"${USER_SHELL_FOLDERS}\" && echo harness-key-read || echo harness-key-failed) & (\"${S32}\\reg.exe\" query \"${SHELL_FOLDERS}\" && echo harness-key-read || echo harness-key-failed)"`]` and `{ env: { SystemRoot: 'C:\\Windows' }, timeout: 3_000, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'ignore'] }`. `KNOWN_FOLDERS_TIMEOUT_MS` is `3_000`.
    - `answers each key, and a key reg.exe could not read as a failure`: stdout `a\r\nharness-key-read\r\nharness-key-failed\r\n` gives `[Buffer.from('a\r\n'), RegFailure 'reg.exe could not read a key']`; stdout `a\r\nharness-key-read\r\n` (the second marker missing) the same.
    - `names the run's failure for every key, with no path`: an `error` with `code: 'ETIMEDOUT'` and message `spawnSync C:\\Windows\\System32\\cmd.exe ETIMEDOUT` gives two `RegFailure` `cmd.exe timed out`; one with `code: 'ENOENT'`: `cmd.exe did not start`; `{ status: 1 }`: `cmd.exe exited 1`. No message holds a `\`.
  - `describe('folderValues')`:
    - `reads AppData and Local AppData among a key's values`: `folderValues(user())` is `{ roaming: '%USERPROFILE%\\AppData\\Roaming', local: '%USERPROFILE%\\AppData\\Local', unreadable: { roaming: false, local: false } }`.
    - `takes text values by name, in any case, with the spaces of a folder's name`: `APPDATA` as `REG_SZ` `C:\Program Files\A B` is `roaming`; `AppData` as `REG_DWORD` is not; `AppData Backup` and `My Local AppData` are not.
    - `ignores what reg.exe says around the values`: `user()` with `Fin de la recherche : 2 correspondance(s) trouvée(s).` (as latin1 bytes) and `ERROR: x` lines before and after answers as `user()` does.
    - `cannot read a value reg.exe printed outside UTF-8, or with a ?`: `folderValues(user(OEM))` has no `roaming` and `unreadable.roaming` true, `local` read; `D:\D?\Roaming` the same; the UTF-8 bytes of `D:\Dữ liệu\Roaming` are read as that string.
  - `describe('expandFolder')`: `%USERPROFILE%\AppData\Roaming` and `%userprofile%\AppData\Roaming` with `home` are `C:\Users\a\AppData\Roaming`; `D:\Redirect\Roaming` with no home is itself; `D:\100%\Roaming` is itself; `%USERPROFILE%\x` with no home, `%HOMESHARE%\AppData`, `%USERPROFILE%\%USERNAME%` and `''` are `undefined`.
  - `describe('readAppDataFolders')`:
    - `is both keys' folders, each once, both keys asked in one run`: `readAppDataFolders(home, keys(user(), shell()))` is `{ roaming: ['C:\\Users\\a\\AppData\\Roaming'], local: ['C:\\Users\\a\\AppData\\Local'] }`; `asked` is `[[USER_SHELL_FOLDERS, SHELL_FOLDERS]]`.
    - `fences a moved AppData, and the place the other key still names`: `keys(user('D:\\Redirect\\Roaming'), shell())` gives `roaming` `['D:\\Redirect\\Roaming', 'C:\\Users\\a\\AppData\\Roaming']`.
    - `skips a value with another variable for the other key's`: `keys(user('%HOMESHARE%\\AppData'), shell('H:\\AppData'))` gives `roaming` `['H:\\AppData']`, and no `failure`.
    - `expands %USERPROFILE% with the home it is given, not the environment's`: with `vi.stubEnv('USERPROFILE', 'Z:\\evil')`, the first case's answer.
    - `keeps what it read and names the failure when a key cannot be read`: `keys(user('D:\\Redirect\\Roaming'), new RegFailure('reg.exe could not read a key'))` gives `roaming` `['D:\\Redirect\\Roaming']` and `failure` `reg.exe could not read a key`; `keys(new RegFailure('cmd.exe timed out'), new RegFailure('cmd.exe timed out'))` gives no folder and `failure` `cmd.exe timed out`.
    - `names a folder reg.exe could not spell, unless the user's key gave it`: `keys(user(OEM), shell(OEM))` and `keys(user(OEM), shell())` have `failure` `reg.exe printed a folder it could not spell` (the user's key is the one that says where the folder is now); `keys(user(), shell(OEM))` has none; `keys(user('%HOMESHARE%\\AppData'), shell(OEM))` has it.
  - `describe('appDataFolders')`, each case after `vi.resetModules()` on a fresh `await import('./knownFolders.js')`:
    - `reads once in a process, and says a failure once`: `read = vi.fn(() => ({ roaming: ['a'], local: ['b'], failure: 'cmd.exe timed out' }))`; two calls with `platform` `'win32'` both answer `{ roaming: ['a'], local: ['b'] }`; `read` ran once, with `home`; `failed` ran once, with `cmd.exe timed out`.
    - `says nothing when the read had no failure`.
    - `reads nothing on macOS and Linux`: `'darwin'` and `'linux'` answer `{ roaming: [], local: [] }`; `read` and `failed` never ran.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/windows/knownFolders.spec.ts`. Expected: FAIL (the module does not exist).
- [ ] **Step 3: Implement `knownFolders.ts`.** Its header says why the registry and not the environment (the caller sets `APPDATA` and `LOCALAPPDATA`, and can unset them), why full paths (`cmd.exe`, `chcp.com`, `reg.exe`: a `reg` earlier on `PATH`, or a `ComSpec`, is the caller's), why `chcp.com 65001` (`reg.exe` prints to a pipe in the console's code page, which lacks most letters), why `/d` (the AutoRun commands the registry may give every `cmd.exe`), and why a failure does not refuse (the spec's "UX first"). `spawnSync` returns a `Buffer` with no `encoding`.
- [ ] **Step 4: Write `knownFolders.windows.real.spec.ts`,** under `(process.platform === 'win32' ? describe : describe.skip)('Windows\' AppData folders, from the real registry', …)`, with a header as `stateFile.real.spec.ts` has (what it proves, Windows only, the command). `afterEach(() => vi.unstubAllEnvs())`. The registry is written only by the scratch-key case, under a key of its own, deleted in that case's `finally`.
  - `finds Windows' own folder through the file system`: `const real = vi.fn(realpathSync.native)`; `systemRoot(real)` equals the `SystemRoot` variable in any case; `real` returned a drive's folder (it did not throw); `System32\cmd.exe`, `System32\chcp.com` and `System32\reg.exe` exist under it.
  - `reads both keys in one cmd.exe run by full paths, under an environment that names nothing`: note `APPDATA` and `LOCALAPPDATA`, then stub `PATH`, `SystemRoot`, `windir`, `ComSpec`, `APPDATA`, `LOCALAPPDATA` and `USERPROFILE` to `Z:\none`. `readAppDataFolders(userInfo().homedir)` has no `failure`; `roaming` and `local` are not empty; one of `roaming` is the folder `APPDATA` named (the same `dev` and `ino`), and one of `local` the folder `LOCALAPPDATA` named.
  - `reads back a value with ö exactly as it was written`: `scratch = HKCU\Software\HarnessKnownFoldersTest-<randomUUID()>`; in `try`, under `${scratch}\User Shell Folders`, written with `spawnSync('reg.exe', ['add', …, '/f'])` as `installPs1.spec.ts` writes its keys: `AppData` `%USERPROFILE%\Redirect\Roaming` (`REG_EXPAND_SZ`), `Local AppData` `D:\Redirect ö\Local` (`REG_SZ`), `Desktop` `x`. `const [answer] = regQuery([`${scratch}\\User Shell Folders`])` is a `Buffer`, and `folderValues(answer)` is `{ roaming: '%USERPROFILE%\\Redirect\\Roaming', local: 'D:\\Redirect ö\\Local', unreadable: { roaming: false, local: false } }`. `finally`: `spawnSync('reg.exe', ['delete', scratch, '/f'])`. This is the case that settles item 7: red here is the switch in "Fallback" below.
  - `names a key that is not there as a failure`: `regQuery([`HKCU\\Software\\HarnessKnownFoldersTest-${randomUUID()}`])` is one `RegFailure` `reg.exe could not read a key`.
  - `takes the time the pull request reports`: five `readAppDataFolders(userInfo().homedir)`, each timed with `performance.now()`; `console.log(\`known folders: ${median} ms a read (median of 5), ${slowest} ms the slowest\`)`; the slowest is under `2 * KNOWN_FOLDERS_TIMEOUT_MS`, the bound the code itself keeps.
- [ ] **Step 5: Run** `cd cli && npx vitest run src/lib/windows/knownFolders.spec.ts src/lib/windows/knownFolders.windows.real.spec.ts src/lib/windows/noWindow.spec.ts && npm run typecheck`. Expected: PASS; on this Mac the real spec reads skipped (5). Its first run is the Windows run.
- [ ] **Step 6: Commit** `Windows: the account's AppData folders are read from the registry, in one cmd.exe run in UTF-8`.

**Fallback (decided, item 7), only if `reads back a value with ö exactly as it was written` is red on the real Windows runner** (`reg.exe` does not print UTF-8 into the pipe after `chcp.com 65001`). A fix in this task's files only (its red test is that Windows run), one commit `Windows: the AppData folders are read by two direct reg.exe runs`, pushed once; Task 5 does not change, since `RegQuery` keeps its shape:
- `regQuery(keys, run)` runs `win32.join(systemRoot(), 'System32', 'reg.exe')` with `['query', key]` once per key: no `cmd.exe`, no `chcp.com`, no `windowsVerbatimArguments`, no markers; the same `env`, `timeout`, `windowsHide` and `stdio`. A run's failure is that key's: `reg.exe timed out`, `reg.exe did not start`, `reg.exe exited <n>`. `systemRoot` may keep its `cmd.exe` characters rule (it only narrows).
- A value not in UTF-8, or holding a `?`, stays `unreadable` and is skipped with the stderr line `reg.exe printed a folder it could not spell`, unless `User Shell Folders` gave that folder.
- The tests follow: the `regQuery` cases expect one `run` per key with `['query', key]` and the `reg.exe …` failures; the scratch-key case expects `local` to be `D:\Redirect ö\Local`, or absent with `unreadable.local` true, never another spelling, and `console.log`s which; the missing key is `reg.exe exited 1`.
- The pull request's number then reads two `reg.exe` runs, and Follow-ups gains "an AppData moved to a path with letters outside ASCII stays unfenced, with the line".

---

### Task 5: The registry's AppData fences an upload (gap 1)

**Depends on:** Tasks 3, 4. **Effort:** `xhigh` (what the fence fences on Windows, and what it leaves open).

**Red test:** `cli/src/lib/connectors/call.spec.ts`.

**Files:**
- Modify: `cli/src/lib/connectors/call.ts` (`tempDir` becomes `tempDirs`; `uploadFile`, `multipart`, `call`)
- Test: `cli/src/lib/connectors/call.spec.ts`

**Interfaces:**
- Consumes: Task 4's `appDataFolders(home, failed)` and `AppDataFolders`; Task 3's `identities`; Task 2's `said`, `sent`, `descriptors`.
- Produces:
  ```ts
  /** The temporary folders left open inside the fenced AppData: the account's own on Windows, and `Temp` under each Local AppData the registry names (decided, item 8). */
  export function tempDirs(home: string | undefined, local: string[], p: PlatformPath = platformPath): string[]
  export function uploadFile(raw: string, env: NodeJS.ProcessEnv = process.env, warn: (line: string) => void = () => undefined): { name: string, content: Buffer }
  ```
  - In `uploadFile`'s folder check: `known = appDataFolders(account, failure => warn(\`upload check: ${failure}; a moved AppData folder may not be fenced\`))`; forbidden is `identities([...forbiddenDirs(env, [homedir(), account]), ...known.roaming, ...known.local])`; temporary is `identities(tempDirs(account, known.local))`. Nothing before the folder check reads the registry.
  - `multipart(fields, env, warn)`; `call` passes `io.err`.
- The spec's mock:
  ```ts
  // The registry's answer, which a test sets; `real` lets the real reader through (Windows only). No case here starts cmd.exe or reg.exe otherwise.
  const registry = vi.hoisted(() => ({
    reads: [] as (string | undefined)[], real: false,
    read: undefined as undefined | ((home: string | undefined, failed: (failure: string) => void) => { roaming: string[], local: string[] }),
  }))
  vi.mock('../windows/knownFolders.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../windows/knownFolders.js')>()
    return { ...actual, appDataFolders: (home: string | undefined, failed: (failure: string) => void) => {
      registry.reads.push(home)
      return registry.read ? registry.read(home, failed) : registry.real ? actual.appDataFolders(home, failed) : { roaming: [], local: [] }
    } }
  })
  ```
  `afterEach` gains `registry.reads = []`, `registry.read = undefined`, `registry.real = false`.

- [ ] **Step 1: Write the failing tests.** `describe('tempDir')` becomes:
  ```ts
  describe('tempDirs', () => {
    it('is the account\'s own AppData\\Local\\Temp on Windows, and Temp under each Local AppData the registry names', () => {
      expect(tempDirs('C:\\Users\\a', [], win32)).toEqual(['C:\\Users\\a\\AppData\\Local\\Temp'])
      expect(tempDirs('C:\\Users\\a', ['D:\\Redirect\\Local', 'C:\\Old\\Local'], win32)).toEqual(['C:\\Users\\a\\AppData\\Local\\Temp', 'D:\\Redirect\\Local\\Temp', 'C:\\Old\\Local\\Temp'])
      expect(tempDirs(undefined, ['D:\\Redirect\\Local'], win32)).toEqual(['D:\\Redirect\\Local\\Temp'])
    })
    it('is none on posix, where no registry names one', () => {
      expect(tempDirs('/home/a', [], posix)).toEqual([])
    })
  })
  ```
  And, with the `beforeEach` and `afterEach` of `describe('uploadFile')`:
  ```ts
  describe('uploadFile and the registry\'s AppData', () => {
    const moved = (...names: string[]): string => {
      mkdirSync(join(home, 'Redirect', ...names), { recursive: true })
      writeFileSync(join(home, 'Redirect', ...names, 'note.txt'), 'x')
      return join(home, 'Redirect', ...names, 'note.txt')
    }

    // On Windows CI `home` is in the account's own AppData\Local\Temp, which is open: only the registry's answer fences these.
    it('fences the folders the registry names with APPDATA and LOCALAPPDATA unset, and leaves the Temp of its Local AppData open', () => {
      registry.read = () => ({ roaming: [join(home, 'Redirect', 'Roaming')], local: [join(home, 'Redirect', 'Local')] })
      expectFenced(moved('Roaming', 'app'))
      expectFenced(moved('Local', 'app'))
      expect(said(moved('Local', 'Temp'))).toBe('sent')
      expect(said(moved('Local', 'Temp', 'docs'))).toBe('sent')
      expect(said(join(home, 'docs', 'note.txt'))).toBe('sent')
      // A folder the registry names on a share is dropped unread, as any forbidden folder there.
      registry.read = () => ({ roaming: ['\\\\harness-no-such-host.invalid\\share\\Roaming'], local: [] })
      expect(said(join(home, 'docs', 'note.txt'))).toBe('sent')
    })

    it('reads the registry with the account\'s home, and only once the file passed its own checks', () => {
      account.home = home
      linkSync(join(home, '.ssh', 'note.txt'), join(home, 'docs', 'link.txt'))
      writeFileSync(join(home, 'docs', 'note.exe'), 'x')
      for (const file of ['docs/note.exe', 'docs/none.txt', 'docs/link.txt']) expect(said(join(home, file)), file).not.toBe('sent')
      expect(registry.reads).toEqual([])
      expect(said(join(home, 'docs', 'note.txt'), { HOME: join(home, 'docs') })).toBe('sent')
      expect(registry.reads).toEqual([home])
    })

    it('says a failed read as one line on stderr, and still uploads', async () => {
      registry.read = (_home, failed) => { failed('cmd.exe timed out'); return { roaming: [], local: [] } }
      const err: string[] = []
      expect(await sent(['--form', `file=@${join(home, 'docs', 'note.txt')}`], err)).toContain('\r\n\r\nx\r\n')
      expect(err).toEqual(['upload check: cmd.exe timed out; a moved AppData folder may not be fenced'])
    })

    it('reads no registry for a request with no @path upload', async () => {
      await sent(['--form', 'title=x'])
      await sent(['--json', '{}'])
      await sent(['--data', 'a=b'])
      await sent([])
      expect(registry.reads).toEqual([])
    })

    // The real cmd.exe, reg.exe and registry: an ordinary upload from Windows' own temporary folder still goes, and nothing is said.
    it.skipIf(process.platform !== 'win32')('takes a document from Windows\' own temporary folder with the real registry read', async () => {
      registry.real = true
      const err: string[] = []
      expect(await sent(['--form', `file=@${join(home, 'docs', 'note.txt')}`], err)).toContain('\r\n\r\nx\r\n')
      expect(err).toEqual([])
      expectFenced(join(home, '.ssh', 'note.txt'))
    })
  })
  ```
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/connectors/call.spec.ts`. Expected: FAIL: `tempDirs is not a function`; the two moved folders are sent; `registry.reads` stays `[]` after the allowed upload; `err` is `[]`. `reads no registry for a request with no @path upload` passes before and after: it holds the spec's anti-goal.
- [ ] **Step 3: Implement** as in "Interfaces". `tempDirs`'s comment keeps `tempDir`'s reason (never `TEMP` or `TMP`, nor a folder under `HOME` or `USERPROFILE`: the caller sets those) and adds the registry's. `tempDir` is gone.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/lib/connectors src/lib/windows/knownFolders.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Connections: the upload fence holds for an AppData moved elsewhere, read from the registry`.

---

## The pull request's body

Written by the main session, not a task. It carries:

- **Design** (small item): the spec's rule in six lines, and "Data: N/A".
- **Platforms:** Windows (gaps 1 and 4, the registry reader), macOS and Linux (gaps 2 and 3; stricter in the same places, otherwise unchanged).
- **Evidence:** each task's red then green commits; the Windows run's link with, per architecture, the three files' counts and the names of the cases skipped there; PR CI's link; the local checks line.
- **The number** (the spec's "Cost"), from the Windows run's log line `known folders: … ms a read (median of 5)`, for x64 and arm64:
  - Windows, a call with an `@path` upload: before, no process; after, one `cmd.exe` run once per command (it runs `chcp.com` and two `reg.exe`), `<n>` ms in all. A second upload in the same command adds none.
  - Windows without `@path`, and macOS and Linux: none, before and after (`reads no registry for a request with no @path upload`, `reads nothing on macOS and Linux`).
  - If Task 4's fallback was taken: two `reg.exe` runs, and the same line.
- **Behavior a caller can see:** the order of the checks (a missing file with a wrong suffix says `only … files`), and the new `cannot check upload`.

## Verification

**Platforms the pull request names:** Windows, macOS, Linux. Each is tested where it runs: Windows in the Windows workflow, Linux in PR CI, macOS on this Mac.

**Never touched:** the real `~/.ssh`, `~/.config`, AppData and the like are only `stat`ed. No test writes outside its own folder under the temporary folder. The real `User Shell Folders` and `Shell Folders` keys are only read; the one registry write is a scratch key `HKCU\Software\HarnessKnownFoldersTest-<uuid>`, which its case deletes in `finally`. No network: `fetch` is stubbed, and the name `harness-no-such-host.invalid` must never be looked up. No account, no daemon, no backend, no production.

**Temporary workflow:** none. The one long check has a workflow of the repo's own that starts by hand on a branch (`.github/workflows/windows.yml`), which already lists `src/lib/connectors/call.spec.ts` and the whole of `src/lib/windows`. No workflow file changes.

**Turns.** The Windows workflow is heavy (two runners, the Rust build, 40 and 60 minutes at most): the tester asks the orchestrator for the lane before starting it, and never runs it beside another heavy workflow.

**Local gates** (docs/validation-and-release.md, "Isolated CLI behavior": typecheck, the affected unit tests, the platform check):
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit. These paths select no check (`--list` on them prints `{}`); its line, "No local check is required.", goes in the pull request's body.
- Not needed: `npm run test:core`, `test:harnessd` and the other coverage gates (no file under `src/core/`, `src/services/`, `src/harnessd/` or in another gate's list), the serial, PTY and shell specs, Desktop.
- `git diff --stat "$(git merge-base HEAD origin/main)" -- .github cli/src/core cli/src/architecture.coreFiles.txt` prints nothing.

**1. macOS, on this Mac, at the final head**
- Run: `cd cli && npm run typecheck && npx vitest run src/lib/connectors src/lib/windows/knownFolders.spec.ts src/lib/windows/knownFolders.windows.real.spec.ts src/lib/windows/noWindow.spec.ts src/architecture.startEnvironment.spec.ts`.
- Isolation: the specs' own. A folder of its own under the run's temporary folder for each case, the account's home through the `node:os` mock, `fetch` stubbed, the registry reader mocked.
- A person sees: every file passes. In `call.spec.ts`, `refuses it in a folder whose spelling the file system did not correct…` ran (APFS folds case: this is the one place gap 3's real disk is exercised), and the four `never sends the file its path was swapped for…` cases ran. Skipped here, and only these: the Windows cases (`refuses a file through a share on Windows…`, `refuses a file reached through a junction…`, `reads no forbidden folder on a share`, `refuses a file in .ssh reached through a subst drive…`, `takes a document from Windows' own temporary folder with the real registry read`) and the five of `knownFolders.windows.real.spec.ts`.

**2. Windows: the Windows workflow, by hand, once, on the final head**
- Start: Actions → Windows → Run workflow, branch `fix/connectors-fence-followup`, inputs as they are (`release` off), or `gh workflow run windows.yml --ref fix/connectors-fence-followup`.
- It runs on `windows-latest` (x64) and `windows-11-arm` (arm64), each a fresh runner: no account, no backend. The step is "Contract suite against the real host, and the Windows CLI specs".
- A person sees, on both architectures:
  - the workflow green, its `install` jobs too;
  - `src/lib/connectors/call.spec.ts` passed. Skipped there, and only these: `never waits on a FIFO named as a document` and `opens the file the kernel reaches through a link…`. Every Windows case of check 1's list ran, with the four swap cases (the runner can make file links) and the case-folded case (NTFS folds case). `refuses a file through a share on Windows…` may read skipped where the runner has no admin share, as in #4442's run;
  - `src/lib/windows/knownFolders.spec.ts` passed, and `src/lib/windows/knownFolders.windows.real.spec.ts` passed with none skipped;
  - in the log, `known folders: <n> ms a read (median of 5), <m> ms the slowest`.
- A failure there is a code failure: fix it, push once, start the workflow again once. If the failure is `reads back a value with ö exactly as it was written`, the fix is Task 4's "Fallback" (two direct `reg.exe` runs), nothing else. A skipped or cancelled job is not verified, never passed.
- Where a Windows machine or VM is at hand, the same three spec files can be run there first (`cd cli && npx vitest run src/lib/connectors/call.spec.ts src/lib/windows/knownFolders.spec.ts src/lib/windows/knownFolders.windows.real.spec.ts`): they write only under `%TEMP%` and the scratch key, and open no window (`windowsHide`). It saves a round of the heavy workflow; the workflow's run is the evidence either way.

**3. In PR CI, by itself:** `cli-typecheck` and `cli-tests` run both spec files on Linux (the case-folded case reads skipped on its case-sensitive disk; the walk's own cases run); a `cli/` change also runs `companions` and `pty-checks`. Nothing is started by hand.

**4. The number:** read from check 2's log, written in the pull request's body as "The pull request's body" says.

**5. A real request with a connected account:** none. From its arguments to the request, the command is `call()`, which the specs drive with only `fetch` stubbed; a real upload needs a connected account and another company's API, and the fence does nothing after the request is built.

**6. Needs the user themselves:** none. **Against production:** none, and never.

## Follow-ups

Not built in this branch; proposals for the maintainers.

- If Task 4's fallback was taken: another way to read the registry in UTF-8, so an AppData moved to a path with letters outside ASCII is fenced too.
- PR CI has no Windows job: these cases run when the Windows workflow is started by hand. A light Windows job for `call.spec.ts` and `src/lib/windows/knownFolders*` on pull requests that touch them would keep them running.
