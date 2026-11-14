/**
 * The code points the round dial draws: a copy, as ranges, of the firmware's `inter_20_codes`
 * (`devices/harness-device/firmware/main/ui/habitat/focus_faces.c`), the table `ui_can_display` checks a question
 * against. The CLI ships without the firmware, so it cannot read the table at run time; the spec fails when they differ.
 */
const ROUND_CODES: ReadonlyArray<readonly [number, number]> = [
  [32, 126], [160, 172], [174, 255], [258, 259], [272, 273], [296, 297], [306, 307], [312, 312], [319, 320],
  [330, 331], [338, 339], [360, 361], [416, 417], [431, 432], [7840, 7929], [8211, 8212], [8216, 8217],
  [8220, 8221], [8226, 8226], [8230, 8230], [8249, 8250], [10003, 10003], [10007, 10007],
]

const drawable = (cp: number): boolean => cp === 0x0a || ROUND_CODES.some(([lo, hi]) => cp >= lo && cp <= hi)

/**
 * The text with each code point the round dial cannot draw as one `?`. The firmware refuses a whole question over one
 * such letter, so a card that must show its command is drawn with gaps instead.
 */
export function roundDrawable(text: string): string {
  let out = ''
  for (const ch of text) out += drawable(ch.codePointAt(0)!) ? ch : '?'
  return out
}
