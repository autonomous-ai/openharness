import { formatDate, slugify } from '../utils.js'

export function exportFileName(day, title) {
  return `${formatDate(day)}-${slugify(title)}.csv`
}
