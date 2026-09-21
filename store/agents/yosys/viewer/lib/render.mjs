// The schematic renderer the server hands requests to: netlistsvg in a worker thread, so a slow
// layout never stalls the event stream. One worker at a time, jobs matched to replies by id, a
// layout that runs past the timeout abandoned (and its worker replaced) rather than waited on.
import { existsSync, readFileSync } from 'node:fs'
import { Worker as ThreadWorker } from 'node:worker_threads'
import { moduleForRender, skinTypes } from './netlist.mjs'

/**
 * @param {{skinPath: string, workerPath: string, timeoutMs?: number, Worker?: typeof ThreadWorker}} options
 * @returns {(net: object) => Promise<string>} draws `net.__module` of the netlist `net`
 */
export function createRenderer({ skinPath, workerPath, timeoutMs = 90_000, Worker = ThreadWorker }) {
  let skin = null, known = new Set()
  let worker = null
  const jobs = new Map()
  let jobSeq = 0
  // A failed job's timer goes with it: left running, it would fire later and kill the next worker.
  const failAll = (error) => {
    for (const j of jobs.values()) { clearTimeout(j.timer); j.reject(error) }
    jobs.clear()
  }
  return function renderSvg(net) {
    if (!skin) {
      if (!existsSync(skinPath)) return Promise.reject(new Error('netlistsvg is not installed here — run toolchain/setup.sh'))
      skin = readFileSync(skinPath, 'utf8')
      known = skinTypes(skin)
    }
    if (!worker) {
      worker = new Worker(workerPath)
      worker.on('message', ({ id, svg, error }) => {
        const job = jobs.get(id)
        if (!job) return
        jobs.delete(id)
        clearTimeout(job.timer)
        if (error || !svg) job.reject(new Error(error || 'netlistsvg drew nothing'))
        else job.resolve(svg)
      })
      worker.on('error', (e) => { failAll(e); worker = null })
      worker.unref()
    }
    return new Promise((resolveJob, rejectJob) => {
      const id = ++jobSeq
      const timer = setTimeout(() => {
        jobs.delete(id)
        // A layout that takes this long will not finish usefully; start a fresh worker for the next.
        worker.terminate(); worker = null
        failAll(new Error('interrupted'))
        rejectJob(new Error(`this module is too large to lay out in the pane (over ${Math.round(timeoutMs / 1000)} s)`))
      }, timeoutMs)
      jobs.set(id, { resolve: resolveJob, reject: rejectJob, timer })
      worker.postMessage({ id, skin, netlist: moduleForRender(net, net.__module, known) })
    })
  }
}
