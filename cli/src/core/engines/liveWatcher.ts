import chokidar, { type FSWatcher } from 'chokidar'
import type { Watcher } from '../../watcher/watcher.js'
import { createLiveSessions, type LiveSessionDeps } from './liveSessions.js'

/** The core watches file names and asks workers to read. Only legacy engines use the local tailer. */
export function createLiveWatcher(local: Watcher, deps: Omit<LiveSessionDeps, 'watch' | 'unwatch'>) {
  const paths = new Set<string>()
  const followUps = new Map<string, ReturnType<typeof setTimeout>>()
  let signals: FSWatcher | null = null
  const change = (path: string): void => {
    live.changed(path)
    // Chokidar suppresses a second change to the same file within 50 ms. A Codex turn can finish
    // and its transcript be shortened before that window closes, after the first read already ran.
    // Read once more after the window so that rewrite cannot remain invisible until reconciliation.
    clearTimeout(followUps.get(path))
    followUps.set(path, setTimeout(() => {
      followUps.delete(path)
      live.changed(path)
    }, 60))
  }
  const live = createLiveSessions({ ...deps,
    watch(path) { paths.add(path); signals?.add(path) },
    unwatch(path) {
      paths.delete(path)
      clearTimeout(followUps.get(path))
      followUps.delete(path)
      void signals?.unwatch(path)
    },
  })
  const watcher: Pick<Watcher, 'on' | 'start' | 'stop' | 'addSession' | 'removeSession' | 'hold' | 'tails' | 'setTail' | 'pollSession' | 'pollAll'> = {
    on: local.on.bind(local),
    start() {
      local.start()
      signals ??= chokidar.watch([...paths], { ignoreInitial: true })
        .on('add', path => live.changed(path)).on('change', change).on('unlink', path => live.changed(path))
    },
    async stop() {
      for (const timer of followUps.values()) clearTimeout(timer)
      followUps.clear()
      await Promise.all([local.stop(), live.stop(), signals?.close()])
      signals = null
    },
    async addSession(session, options) {
      if (!deps.handles(session.engine)) return local.addSession(session, options)
      await local.removeSession(session.sessionId)
      const bound = deps.bySession(session.sessionId)
      if (bound?.transcriptPath === session.transcriptPath) await live.follow(bound)
    },
    async removeSession(id) { await Promise.all([local.removeSession(id), live.removeSession(id)]) },
    hold: (id, path, timeout) => live.tails(id, path) ? live.hold(id, path, timeout) : local.hold(id, path, timeout),
    tails: (id, path) => live.tails(id, path) || local.tails(id, path),
    setTail(id, offset) { local.setTail(id, offset); live.setTail(id, offset) },
    async pollSession(id) { await Promise.all([local.pollSession(id), live.pollSession(id)]) },
    async pollAll() { await Promise.all([local.pollAll(), live.pollAll()]) },
  }
  return { live, watcher }
}
