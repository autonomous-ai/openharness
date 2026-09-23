/** Generate/check the OS handoff schemas from the validators used by the device facade. */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { DeviceStoreRequestSchema, DeviceStoreResultSchema } from '../src/lib/autonomous-device/storeContract.js'
for (const [name, schema] of [['request', DeviceStoreRequestSchema], ['response', DeviceStoreResultSchema]] as const) {
  const file = fileURLToPath(new URL(`../../docs/contracts/autonomous-device-store-v1/${name}.schema.json`, import.meta.url))
  const text = JSON.stringify(z.toJSONSchema(schema, { io: name === 'request' ? 'input' : 'output' }), null, 2) + '\n'
  if (process.argv.includes('--check')) {
    if (readFileSync(file, 'utf8') !== text) throw new Error(`Contract drift: regenerate ${file} and coordinate the change with Autonomous OS.`)
  } else writeFileSync(file, text)
}
