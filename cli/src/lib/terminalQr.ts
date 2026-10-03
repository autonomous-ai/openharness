import qrcode from 'qrcode-generator'

/**
 * A QR code drawn in a terminal: two module rows per text line with half blocks, dark on light, and
 * a quiet zone phones need to find the code. Colours are forced (black on white) rather than left to
 * the terminal's theme, because a light-on-dark code is one many scanners refuse.
 */
export function terminalQr(text: string, { margin = 2, color = true }: { margin?: number; color?: boolean } = {}): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const size = qr.getModuleCount()
  const dark = (r: number, c: number): boolean =>
    r >= 0 && c >= 0 && r < size && c < size && qr.isDark(r, c)
  const lines: string[] = []
  for (let r = -margin; r < size + margin; r += 2) {
    let line = ''
    for (let c = -margin; c < size + margin; c++) {
      const top = dark(r, c)
      const bottom = dark(r + 1, c)
      // Drawn in the LIGHT colour: a full block is two light modules, a space two dark ones.
      line += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█'
    }
    lines.push(color ? `\x1b[97;40m${line}\x1b[0m` : line)
  }
  return lines.join('\n')
}
