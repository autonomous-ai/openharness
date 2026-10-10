// Private fixture: make only publication of an engine-home adoption unavailable until its flag is moved.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const link = fs.linkSync
fs.linkSync = function (from, to) {
  const flag = process.env.HARNESS_HOME_ADOPTION_FAULT_FILE
  if (flag && fs.existsSync(flag) && /engine-homes\.json\.adoptions\/\d{3}\.json$/.test(String(to))) {
    throw Object.assign(new Error('fixture home adoption storage unavailable'), { code: 'EIO' })
  }
  return link.call(this, from, to)
}
syncBuiltinESMExports()
