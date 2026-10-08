/**
 * V8 keeps a script's whole source in memory, one byte a character only while every character is
 * Latin-1: one above U+00FF and the whole file takes two. esbuild escapes strings and plain templates
 * but not regular expressions, tagged templates or the banner, and the `✳ ❯ │ ⌘` the pane parsers
 * match on made the 5.0 MB cli.js a 9.5 MB string in the core's heap (measured 2026-10-07).
 *
 * `\uXXXX` means the same character in a regular expression (an emoji's two escapes are one code
 * point under `u`, two code units without it, as the literal was) and in a comment. In a tagged
 * template it changes the raw text; the only ones that carry such characters build RegExp sources
 * (lib/askQuestion.ts, and Codex's startup update line in engines/codex/launch.ts, which the kit writes into
 * a probe's regular expression), where the escape and the character match alike. Checked 2026-10-07:
 * all 133 regular expressions in the bundle matched the same as their escaped form on random input.
 */
export function asciiOnly(code) {
  // An escaped character (`\✳`) would become a backslash followed by the text `✳`.
  if (/\\[^\x00-\xff]/.test(code)) throw new Error('a backslash precedes a character above U+00FF')
  return code.replace(/[^\x00-\xff]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
