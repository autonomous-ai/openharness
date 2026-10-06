// Test-only preload. QA needed the core's CPU, not its master's or its children's.
// Nothing is loaded into production; only the opt-in E2E supplies these settings.
if (process.argv.includes('__run') && process.env.HARNESS_E2E_PERF_DIR && process.env.HARNESS_E2E_PERF_TOKEN) {
  const { createServer } = require('node:http')
  const { writeFileSync, renameSync } = require('node:fs')
  const { join } = require('node:path')
  const { monitorEventLoopDelay, performance } = require('node:perf_hooks')
  const { writeHeapSnapshot } = require('node:v8')
  const directory = process.env.HARNESS_E2E_PERF_DIR
  const token = process.env.HARNESS_E2E_PERF_TOKEN
  const micros = () => Number(process.hrtime.bigint() / 1000n)
  let phase = null

  function begin(label) {
    if (phase) throw new Error('a measurement is already running')
    const delay = monitorEventLoopDelay({ resolution: 10 })
    const memory = process.memoryUsage()
    const rss = [memory.rss]
    const timer = setInterval(() => { rss.push(process.memoryUsage.rss()) }, 1000)
    timer.unref()
    delay.enable()
    phase = { label, memory, rss, timer, delay, utilization: performance.eventLoopUtilization(),
      startUs: micros(), cpu: process.cpuUsage() }
    return { pid: process.pid, label, startUs: phase.startUs }
  }

  function end() {
    if (!phase) throw new Error('no measurement is running')
    const cpu = process.cpuUsage(phase.cpu)
    const endUs = micros()
    const utilization = performance.eventLoopUtilization(phase.utilization)
    const measured = phase
    phase = null
    clearInterval(measured.timer)
    measured.delay.disable()
    const memory = process.memoryUsage()
    measured.rss.push(memory.rss)
    const elapsedUs = endUs - measured.startUs
    const milliseconds = value => Number.isFinite(value) ? value / 1e6 : null
    return {
      pid: process.pid, label: measured.label, startUs: measured.startUs, endUs,
      durationSeconds: elapsedUs / 1e6,
      cpu: { userUs: cpu.user, systemUs: cpu.system, percent: 100 * (cpu.user + cpu.system) / elapsedUs },
      memory: { start: measured.memory, end: memory, rssMin: Math.min(...measured.rss),
        rssMax: Math.max(...measured.rss), rssMean: measured.rss.reduce((a, b) => a + b, 0) / measured.rss.length,
        samples: measured.rss.length },
      eventLoop: { utilization: utilization.utilization, delaySamples: measured.delay.count,
        meanMs: milliseconds(measured.delay.mean), p50Ms: milliseconds(measured.delay.percentile(50)),
        p95Ms: milliseconds(measured.delay.percentile(95)), p99Ms: milliseconds(measured.delay.percentile(99)),
        maxMs: milliseconds(measured.delay.max) },
    }
  }

  const server = createServer((request, response) => {
    const answer = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (request.method !== 'POST' || request.headers['x-harness-perf-token'] !== token) {
      answer(403, { error: 'test probe credential required' })
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      body += chunk
      if (body.length > 1024) request.destroy()
    })
    request.on('end', () => {
      try {
        const { label } = JSON.parse(body || '{}')
        if (request.url === '/end') { answer(200, end()); return }
        if (!/^[a-z][a-z0-9-]{0,40}$/.test(label || '')) throw new Error('a short phase label is required')
        if (request.url === '/start') { answer(200, begin(label)); return }
        if (request.url === '/heap') {
          if (phase) throw new Error('heap snapshots must be outside a measurement')
          const startUs = micros()
          const file = join(directory, label + '-' + process.pid + '-' + startUs + '.heapsnapshot')
          writeHeapSnapshot(file)
          answer(200, { pid: process.pid, file, durationSeconds: (micros() - startUs) / 1e6 })
          return
        }
        throw new Error('unknown test probe command')
      } catch (error) { answer(400, { error: String(error.message || error) }) }
    })
  })
  server.requestTimeout = 120000
  server.on('error', error => { console.error('[perf-probe]', error.message) })
  server.listen(0, '127.0.0.1', () => {
    const ready = join(directory, 'core-' + process.pid + '.json')
    writeFileSync(ready + '.pending', JSON.stringify({
      pid: process.pid, port: server.address().port, node: process.version,
    }), { flag: 'wx', mode: 0o600 })
    renameSync(ready + '.pending', ready)
    server.unref()
  })
  process.once('exit', () => {
    if (phase) { clearInterval(phase.timer); phase.delay.disable() }
  })
}
