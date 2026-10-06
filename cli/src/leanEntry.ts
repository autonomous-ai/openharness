/**
 * The lean bundle's entry: harnessd's master and its services, and nothing else (harnessd/leanBundle.ts).
 *
 * Built a second time, on its own, and carried inside cli.js, so that the master and each service start
 * on their own code instead of the whole CLI's 4.4 MB: Node parses every byte of the files a process
 * loads, and the whole CLI cost each of them about 45 MiB at idle. Built split, each dynamic import below
 * a file of its own with what only it uses, so a process loads this file, its own and the shared ones it
 * imports: the master never the services' code, a service never the master's nor another service's
 * (leanEntry.spec.ts holds it to that). A master started on cli.js re-executes on this file
 * (masterProcess.ts `startMasterFromBundle`) and starts the services from it. The core and the CLI
 * always run from cli.js.
 */
import { fileURLToPath } from 'node:url'

const [, , command, name] = process.argv
if (command === '__harnessd') {
  const master = await import('./masterProcess.js')
  const bundle = process.env[master.BUNDLE_ENV]
  if (!bundle) {
    console.error('[harnessd] the lean bundle runs a master only for the cli.js it was read from, which hands over its path')
    process.exit(2)
  }
  const bundleFingerprint = process.env[master.BUNDLE_SHA256_ENV]
  const leanFingerprint = process.env[master.LEAN_FINGERPRINT_ENV]
  // Not for the core and the services: neither starts a master, and a master started from cli.js again,
  // after an update, hands over its own.
  delete process.env[master.BUNDLE_ENV]
  delete process.env[master.BUNDLE_SHA256_ENV]
  delete process.env[master.LEAN_FINGERPRINT_ENV]
  master.startMaster({
    scriptPath: bundle,
    serviceScriptPath: fileURLToPath(import.meta.url),
    ...(bundleFingerprint ? { bundleFingerprint } : {}),
    ...(leanFingerprint ? { leanFingerprint } : {}),
  })
} else if (command === '__harnessd-probe') {
  process.exitCode = (await import('./masterProcess.js')).probeThisMaster()
} else if (command === '__service') {
  await (await import('./serviceProcess.js')).startServiceProcess(name)
} else {
  console.error(`[harnessd] the lean bundle runs harnessd's master and its services; ${command ?? 'nothing'} is the CLI's (cli.js)`)
  process.exit(2)
}
