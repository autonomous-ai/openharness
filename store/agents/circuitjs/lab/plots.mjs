export const COLORS = [
  '#6fddc1',
  '#f3bd6a',
  '#8bafff',
  '#ef98c3',
  '#c4acff',
  '#a6d782',
  '#f29887',
  '#85d5eb'
]
export function quantity(value, unit = '') {
  if (!Number.isFinite(value)) return '—'
  const scales = [
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'k'],
    [1, ''],
    [1e-3, 'm'],
    [1e-6, 'µ'],
    [1e-9, 'n']
  ]
  if (!value) return `0 ${unit}`.trim()
  for (const [scale, prefix] of scales)
    if (Math.abs(value) >= scale)
      return `${Number((value / scale).toPrecision(4))} ${prefix}${unit}`.trim()
  return `${value.toExponential(2)} ${unit}`.trim()
}
export function nearestSample(samples, time) {
  if (!samples.length) return null
  let lo = 0,
    hi = samples.length - 1
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (samples[mid][0] < time) lo = mid + 1
    else hi = mid
  }
  return lo &&
    Math.abs(samples[lo - 1][0] - time) < Math.abs(samples[lo][0] - time)
    ? samples[lo - 1]
    : samples[lo]
}
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;'
      })[c]
  )
export function traceBounds(take, column, reference = null) {
  const probe = take.probes[column],
    other =
      reference?.probes.findIndex(
        (p) => p.id === probe.id && p.unit === probe.unit
      ) ?? -1
  let min = Infinity,
    max = -Infinity
  for (const row of take.samples) {
    min = Math.min(min, row[column + 1])
    max = Math.max(max, row[column + 1])
  }
  if (other >= 0)
    for (const row of reference.samples) {
      min = Math.min(min, row[other + 1])
      max = Math.max(max, row[other + 1])
    }
  if (!Number.isFinite(min)) {
    min = -1
    max = 1
  }
  const pad = (max - min) * 0.12 || Math.max(Math.abs(max) * 0.1, 0.001)
  return {
    min: min - pad,
    max: max + pad,
    other,
    end: Math.max(
      take.samples.at(-1)?.[0] || take.config.duration,
      other >= 0 ? reference.samples.at(-1)?.[0] || 0 : 0
    )
  }
}
export function captureSVG(take) {
  const width = 1100,
    height = 86 + take.probes.length * 170,
    left = 94,
    right = width - 24
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#111820"/><g font-family="system-ui,sans-serif" fill="#e6eef4"><text x="24" y="30" font-size="20">${esc(take.title)}</text><text x="24" y="53" font-size="12" fill="#a1aebe">Native CircuitJS solver observations · ${take.samples.length} stored samples · ${esc(take.status)} · sampled values, not hardware measurements</text>`
  ]
  take.probes.forEach((probe, col) => {
    const y = 85 + col * 170,
      bottom = y + 110,
      bounds = traceBounds(take, col)
    const px = (t) => left + ((right - left) * t) / bounds.end
    const py = (v) =>
      bottom - ((v - bounds.min) * 110) / (bounds.max - bounds.min)
    svg.push(
      `<text x="24" y="${y - 8}" font-size="13" fill="${COLORS[col]}">${esc(probe.label)}</text>`
    )
    for (let i = 0; i <= 4; i++) {
      const gy = y + i * 27.5,
        value = bounds.max - ((bounds.max - bounds.min) * i) / 4
      svg.push(
        `<path d="M${left} ${gy}H${right}" stroke="#2d3640"/><text x="${left - 8}" y="${gy + 4}" text-anchor="end" font-size="10" fill="#a1aebe">${esc(quantity(value, probe.unit))}</text>`
      )
    }
    for (let i = 0; i <= 5; i++)
      svg.push(
        `<text x="${px((bounds.end * i) / 5)}" y="${bottom + 19}" text-anchor="middle" font-size="10" fill="#a1aebe">${esc(quantity((bounds.end * i) / 5, 's'))}</text>`
      )
    const path = take.samples
      .map(
        (row, i) =>
          `${i ? 'L' : 'M'}${px(row[0]).toFixed(2)},${py(row[col + 1]).toFixed(2)}`
      )
      .join(' ')
    svg.push(
      `<path d="${path}" fill="none" stroke="${COLORS[col]}" stroke-width="1.7"/>`
    )
  })
  return svg.join('') + '</g></svg>'
}

export function drawCapture(
  canvas,
  take,
  reference,
  cursors = {},
  window = null
) {
  const width = Math.max(260, canvas.parentElement.clientWidth),
    height = 40 + take.probes.length * 170,
    ratio = Math.min(2, globalThis.devicePixelRatio || 1)
  canvas.style.height = `${height}px`
  canvas.width = width * ratio
  canvas.height = height * ratio
  const ctx = canvas.getContext('2d')
  ctx.scale(ratio, ratio)
  ctx.fillStyle = '#101720'
  ctx.fillRect(0, 0, width, height)
  const left = 74,
    right = width - 18
  take.probes.forEach((probe, col) => {
    const y = 32 + col * 170,
      bottom = y + 106,
      bounds = traceBounds(take, col, reference)
    const start = window?.start || 0,
      end = window?.end || bounds.end
    const px = (t) => left + ((right - left) * (t - start)) / (end - start),
      py = (v) => bottom - ((v - bounds.min) * 106) / (bounds.max - bounds.min)
    ctx.fillStyle = COLORS[col]
    ctx.font = '12px system-ui'
    ctx.textAlign = 'left'
    ctx.fillText(
      probe.label.length > 48 ? probe.label.slice(0, 47) + '…' : probe.label,
      15,
      y - 9
    )
    ctx.font = '10px system-ui'
    for (let i = 0; i <= 4; i++) {
      const gy = y + i * 26.5
      ctx.strokeStyle = '#2c3541'
      ctx.beginPath()
      ctx.moveTo(left, gy)
      ctx.lineTo(right, gy)
      ctx.stroke()
      ctx.fillStyle = '#a1afbf'
      ctx.textAlign = 'right'
      ctx.fillText(
        quantity(bounds.max - ((bounds.max - bounds.min) * i) / 4, probe.unit),
        left - 7,
        gy + 3
      )
    }
    ctx.textAlign = 'center'
    for (let i = 0; i <= 4; i++) {
      const time = start + ((end - start) * i) / 4
      ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center'
      ctx.fillText(quantity(time, 's'), px(time), bottom + 18)
    }
    const line = (rows, index, color, dashed) => {
      ctx.strokeStyle = color
      ctx.lineWidth = 1.6
      ctx.setLineDash(dashed ? [5, 4] : [])
      ctx.beginPath()
      rows.forEach((row, i) => {
        const x = px(row[0]),
          v = py(row[index + 1])
        if (i) ctx.lineTo(x, v)
        else ctx.moveTo(x, v)
      })
      ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.save()
    ctx.beginPath()
    ctx.rect(left, y, right - left, bottom - y)
    ctx.clip()
    if (bounds.other >= 0)
      line(reference.samples, bounds.other, '#a0a8b5', true)
    line(take.samples, col, COLORS[col], false)
    ctx.restore()
    ctx.textAlign = 'center'
    for (const [key, time] of Object.entries(cursors)) {
      if (!Number.isFinite(time) || time < start || time > end) continue
      ctx.strokeStyle = key === 'a' ? '#f2d783' : '#d6aaf9'
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(px(time), y)
      ctx.lineTo(px(time), bottom)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = ctx.strokeStyle
      ctx.fillText(key.toUpperCase(), px(time), y + 11)
    }
  })
  return { left, right, width }
}
