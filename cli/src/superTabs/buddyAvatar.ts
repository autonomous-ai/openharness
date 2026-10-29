/**
 * A Buddy's face on the round dial: Desktop's agent pattern
 * (`desktop/lib/super_tabs/avatar_art.dart`, `superTabAgentPattern`), ported
 * exactly so the dial and the app draw the same Buddy. The dial has no uploaded
 * or preset pictures, so this is the only face it shows.
 */
export interface BuddyAvatar {
  /** The 15 half bits of the 5×5 grid; bit `i` is `half[i]`, mirrored on the dial. */
  cells: number
  /** HSL(hue, 42 %, 72 %), Desktop's dark-mode tone, as `#rrggbb`. */
  color: string
}

const HALF_MASK = 0x7fff
/** Desktop lights the centre column's middle cell when every half bit is off. */
const FALLBACK_CELL = 1 << 7
const SATURATION = 0.42
const LIGHTNESS = 0.72

/** FNV-1a, 32 bits, over UTF-16 code units, as Dart's `String.codeUnits`. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
  return hash
}

/** The channels of a hue at the dial's tone, ordered as Flutter's `HSLColor.toColor()` picks them. */
function channels(hue: number, chroma: number, secondary: number): [number, number, number] {
  if (hue < 60) return [chroma, secondary, 0]
  if (hue < 120) return [secondary, chroma, 0]
  if (hue < 180) return [0, chroma, secondary]
  if (hue < 240) return [0, secondary, chroma]
  if (hue < 300) return [secondary, 0, chroma]
  return [chroma, 0, secondary]
}

/** Flutter's HSL to RGB, with its rounding, so a colour never differs from the app's by one step. */
function toneOf(hue: number): string {
  const chroma = (1 - Math.abs(2 * LIGHTNESS - 1)) * SATURATION
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const match = LIGHTNESS - chroma / 2
  return `#${channels(hue, chroma, secondary)
    .map(channel => Math.round((channel + match) * 0xff).toString(16).padStart(2, '0'))
    .join('')}`
}

export function buddyAvatar(name: string): BuddyAvatar {
  const hash = fnv1a(name.trim().toLowerCase())
  return { cells: hash & HALF_MASK || FALLBACK_CELL, color: toneOf((hash >>> 16) % 360) }
}
