import { log } from '../../../lib/logger-v1.js'

export function toCsv(rows) {
  if (rows.length === 0) {
    log.warn('empty report', { rows: 0 })
    return ''
  }
  const columns = Object.keys(rows[0])
  const lines = rows.map((row) => columns.map((column) => JSON.stringify(row[column] ?? '')).join(','))
  log.info('report built', { rows: rows.length, columns: columns.length })
  return [columns.join(','), ...lines].join('\n')
}
