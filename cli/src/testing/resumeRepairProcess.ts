/** A real isolated subprocess, with no daemon, tmux or user-home access. */
import { fork, type ForkOptions } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function startResumeRepairWorker(profile: string, pausePrepared = false) {
  const child = fork(fileURLToPath(new URL('./resumeRepairChild.ts', import.meta.url)), pausePrepared ? ['pause-prepared'] : [], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true, // Node's fork forwards this spawn option.
    env: { ...process.env, HOME: profile, USERPROFILE: profile, ADAPTER_DATA_DIR: join(profile, 'state'), CODEX_HOME: profile },
  } as ForkOptions & { windowsHide: boolean })
  child.stderr?.resume()
  const pending = new Map<number, { resolve(answer: Record<string, unknown>): void; reject(error: Error): void }>()
  let next = 0
  let prepared!: (answer: Record<string, unknown>) => void
  const staged = new Promise<Record<string, unknown>>(resolve => { prepared = resolve })
  const exited = new Promise<void>(resolve => child.once('exit', () => {
    for (const call of pending.values()) call.reject(new Error('worker exited'))
    pending.clear(); resolve()
  }))
  child.on('message', (reply: { id?: number; answer?: Record<string, unknown>; staged?: Record<string, unknown> }) => {
    if (reply.staged) prepared(reply.staged)
    if (reply.id === undefined) return
    pending.get(reply.id)?.resolve(reply.answer!); pending.delete(reply.id)
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('worker startup timed out')) }, 10_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('worker exited before ready')) })
    child.once('message', () => { clearTimeout(timer); resolve() })
  })
  return { child, staged, proceed: () => { child.send({ proceed: true }) },
    call: (_service: string, method: string, payload: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve, reject })
      child.send({ id, method, payload }, error => { if (error) { pending.delete(id); reject(error) } })
    }),
    async stop(): Promise<void> {
      child.kill()
      const timeout = setTimeout(() => { child.kill('SIGKILL') }, 1000)
      let deadline: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([exited, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('worker exit timed out')), 10_000)
      })]) } finally { clearTimeout(timeout); clearTimeout(deadline) }
    },
  }
}
