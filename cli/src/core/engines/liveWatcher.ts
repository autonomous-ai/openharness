import chokidar, { type FSWatcher } from 'chokidar'
import type { Watcher } from '../../watcher/watcher.js'
import { createLiveSessions, type LiveSessionDeps } from './liveSessions.js'

/** The core watches file names and asks workers to read. Only legacy engines use the local tailer. */
export function createLiveWatcher(local: Watcher, deps: Omit<LiveSessionDeps, 'watch' | 'unwatch'>) {
  const paths = new Set<string>()
  let signals: FSWatcher | null = null
  const live = createLiveSessions({ ...deps,
    watch(path) { paths.add(path); signals?.add(path) },
    unwatch(path) { paths.delete(path); void signals?.unwatch(path) },
  })
  const watcher: Pick<Watcher, 'on' | 'start' | 'stop' | 'addSession' | 'removeSession' | 'hold' | 'tails' | 'setTail' | 'pollSession' | 'pollAll'> = {
    on: local.on.bind(local),
    start() {
      local.start()
      signals ??= chokidar.watch([...paths], { ignoreInitial: true })
        .on('add', path => live.changed(path)).on('change', path => live.changed(path)).on('unlink', path => live.changed(path))
    },
    async stop() { await Promise.all([local.stop(), live.stop(), signals?.close()]); signals = null },
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
