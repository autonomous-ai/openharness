// Worker for benchmark-serial-idle.py. Opens only the driver's disposable PTYs.
import { pathToFileURL } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'
import assert from 'node:assert/strict'

const { SerialLink } = await import(pathToFileURL(process.argv[2]).href)
const ports = JSON.parse(process.argv[3])
let bytes = 0, closed = 0
const links = []
try {
  for (const port of ports) {
    links.push(await SerialLink.open(port, chunk => { bytes += chunk.length }, () => { closed++ }))
  }
  await wait(350)
  assert.equal(bytes, 0)
  assert.equal(closed, 0)
  process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, node: process.version, uv: process.versions.uv }) + '\n')
  const begin = process.hrtime.bigint(), initialResources = process.resourceUsage(), initialCpu = process.cpuUsage()
  await wait(12_000)
  const cpu = process.cpuUsage(initialCpu)
  const elapsedMs = Number(process.hrtime.bigint() - begin) / 1e6
  const resources = process.resourceUsage()
  const result = {
    pid: process.pid, ports: ports.length, elapsedMs,
    userCpuMs: cpu.user / 1000, systemCpuMs: cpu.system / 1000,
    cpuPercentOneCore: (cpu.user + cpu.system) / (elapsedMs * 10),
    voluntaryContextSwitches: resources.voluntaryContextSwitches - initialResources.voluntaryContextSwitches,
    involuntaryContextSwitches: resources.involuntaryContextSwitches - initialResources.involuntaryContextSwitches,
    receivedBytes: bytes, unexpectedlyClosed: closed, rssBytes: process.memoryUsage().rss,
  }
  assert.equal(bytes, 0)
  assert.equal(closed, 0)
  assert(links.every(link => link.isOpen))
  await Promise.all(links.map(link => link.close('benchmark complete')))
  assert.equal(closed, ports.length)
  assert(links.every(link => !link.isOpen))
  process.stdout.write(JSON.stringify(result) + '\n')
} finally {
  await Promise.all(links.map(link => link.close('benchmark cleanup')))
}
