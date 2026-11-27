const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB']

export function formatBytes(bytes) {
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit++
  }
  return `${Number(value.toFixed(1))} ${UNITS[unit]}`
}
