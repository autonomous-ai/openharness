/** A POST to the backend, as the CLI makes it. */
export type Post = <T>(path: string, body: unknown, headers?: Record<string, string>) => Promise<T>

/** Sign a Harness-issued session out on the backend: a computer's or a phone's (`hnr_`), or a team one (`htr_`). Best
 *  effort: an Autonomous sign-in is not ours to revoke. */
export async function revokeHarnessRefresh(post: Post, refreshToken: string | undefined): Promise<boolean> {
  if (!refreshToken?.startsWith('hnr_') && !refreshToken?.startsWith('htr_')) return false
  try {
    await post('/api/auth/revoke', { refreshToken })
    return true
  } catch {
    return false
  }
}
