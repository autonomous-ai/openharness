import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** A handle as a branch takes it: `Dee Huynh` → `dee-huynh`. Null when nothing is left. */
export function ownerSlug(raw: string | null | undefined): string | null {
  const slug = (raw ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 39).replace(/-+$/, '')
  return slug || null
}

let owner: Promise<string> | undefined

/** Whose branches Harness makes on this machine — `<owner>/<session name>`: the GitHub login `gh` is
 *  signed in as (the handle, `deehw`, not the display name), else Git's `github.user`, else its
 *  `user.name`, else this account's login. Asked once per process. `HARNESS_BRANCH_OWNER` overrides. */
export function branchOwner(): Promise<string> {
  return owner ??= (async () => {
    const run = (command: string, args: string[]) => exec(command, args, {
      timeout: 4000, killSignal: 'SIGKILL',
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
    }).then(result => result.stdout.trim(), () => '')
    const sources: Array<() => Promise<string> | string> = [
      () => process.env.HARNESS_BRANCH_OWNER ?? '',
      () => run('gh', ['api', 'user', '--jq', '.login']),
      () => run('git', ['config', '--global', '--get', 'github.user']),
      () => run('git', ['config', '--global', '--get', 'user.name']),
      () => { try { return userInfo().username } catch { return '' } },
    ]
    for (const source of sources) {
      const slug = ownerSlug(await source())
      if (slug) return slug
    }
    return 'harness'
  })()
}
