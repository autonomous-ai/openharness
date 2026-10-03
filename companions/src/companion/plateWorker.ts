/**
 * The plate worker: draws individual art off harnessd's event loop (pair/plateService.ts).
 *
 * The build bundles this file, with the shader and the models it imports, into one CommonJS string
 * (scripts/lib/plateWorker.mjs, `__PLATE_WORKER__` in both builds), and harnessd starts it with
 * `new Worker(source, { eval: true })`: the release ships one `cli.js`, so a worker cannot be a file
 * beside it. One job at a time: `{ n, job }` in, `{ n, unit, ms }` or `{ n, error }` out.
 */
import { parentPort } from 'node:worker_threads'
import { renderPlateUnit, type PlateJob } from './plateRender.js'

parentPort?.on('message', (message: { n: number; job: PlateJob }) => {
  const started = performance.now()
  try {
    const unit = renderPlateUnit(message.job)
    parentPort?.postMessage({ n: message.n, unit, ms: Math.round(performance.now() - started) })
  } catch (err) {
    parentPort?.postMessage({ n: message.n, error: err instanceof Error ? err.message : String(err) })
  }
})
