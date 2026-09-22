// The sheet and Question Lab must send the same question for the same header and context.
import { jev } from '../toolchain/jev.mjs'

export function questionForColumn(col, context = '') {
  const ctx = context ? `${context} ` : ''
  if (col.type === 'noul') return jev.noul(`${ctx}${col.header}`)
  if (col.type === 'choice')
    return jev.choice(
      Object.fromEntries(
        col.options.map((o) => [o, col.descriptions?.[o] || o])
      ),
      `${ctx}${col.name}: which option fits this row best?`
    )
  return jev.score(
    col.levels,
    `${ctx}${col.name}: where does this row sit on the scale?`
  )
}
