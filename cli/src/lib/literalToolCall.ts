/** Read a small literal subset of code-mode calls. This never evaluates JavaScript. */
function literal(source: string, prefix = false): { value: unknown; length: number } {
  let at = 0
  const fail = (): never => { throw new Error('Not a literal') }
  const space = () => { while (/\s/.test(source[at] ?? '') && at < source.length) at++ }
  function string(): string {
    const quote = source[at++]
    let result = ''
    while (at < source.length) {
      let ch = source[at++]
      if (ch === quote) return result
      if (quote === '`' && ch === '$' && source[at] === '{') fail()
      if (ch === '\n' && quote !== '`') fail()
      if (ch === '\\') {
        ch = source[at++]
        if (ch === undefined) fail()
        if (ch === '\n') continue
        if (ch === 'u' || ch === 'x') {
          const count = ch === 'u' ? 4 : 2, digits = source.slice(at, at + count)
          if (digits.length !== count || !/^[a-f0-9]+$/i.test(digits)) fail()
          result += String.fromCharCode(parseInt(digits, 16)); at += count; continue
        }
        if (/\d/.test(ch)) fail() // Legacy octal and \0 are not needed for tool arguments.
        result += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' } as Record<string, string>)[ch] ?? ch
      } else result += ch
    }
    return fail()
  }
  function value(depth = 0): unknown {
    if (depth > 4) fail()
    space()
    const ch = source[at]
    if (["'", '"', '`'].includes(ch)) return string()
    if (ch === '{') {
      at++; space()
      const result: Record<string, unknown> = Object.create(null)
      let count = 0
      while (source[at] !== '}') {
        if (++count > 32) fail()
        space()
        let key: string
        if (["'", '"'].includes(source[at])) key = string()
        else {
          const identifier = /^[a-zA-Z_$][\w$]*/.exec(source.slice(at))?.[0]
          if (!identifier) fail()
          key = identifier!; at += key.length
        }
        if (Object.hasOwn(result, key)) fail()
        space(); if (source[at++] !== ':') fail()
        result[key] = value(depth + 1); space()
        if (source[at] === '}') break
        if (source[at++] !== ',') fail()
        space()
      }
      at++; return result
    }
    if (ch === '[') {
      at++; space()
      const result: unknown[] = []
      while (source[at] !== ']') {
        if (result.length >= 32) fail()
        result.push(value(depth + 1)); space()
        if (source[at] === ']') break
        if (source[at++] !== ',') fail()
        space()
      }
      at++; return result
    }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(at))?.[0]
    if (!primitive) fail()
    at += primitive!.length
    return JSON.parse(primitive!)
  }
  const result = value()
  space(); if (!prefix && at !== source.length) fail()
  return { value: result, length: at }
}

export function literalToolCall(raw: string): { name: string; input: unknown } | null {
  if (raw.length > 128 * 1024) return null
  const source = raw.replace(/^\s*\/\/ @exec:[^\n]*\n/, '').trim()
  const wrapped = /^text\(\s*await\s+tools\.(exec_command|apply_patch|write_stdin)\(([\s\S]*)\)\s*\)\s*;?$/.exec(source)
    ?? /^await\s+tools\.(exec_command|apply_patch|write_stdin)\(([\s\S]*)\)\s*;?$/.exec(source)
  const assigned = /^(?:const|let)\s+([a-zA-Z_$][\w$]*)\s*=\s*await\s+tools\.(exec_command|apply_patch|write_stdin)\(([\s\S]*)\)\s*;\s*text\(\s*\1\s*\)\s*;?$/.exec(source)
  const name = wrapped?.[1] ?? assigned?.[2], argument = wrapped?.[2] ?? assigned?.[3]
  if (!name || argument === undefined) return null
  try { return { name, input: literal(argument).value } } catch { return null }
}

export type ToolOutputSlot = { block: number; settled?: boolean; index?: number }
export type LiteralToolCall = { name: string; input: unknown; group: number; output?: ToolOutputSlot }

/** The ordinary code-mode orchestration grammar, not a JavaScript interpreter.
 * Accept complete unconditional statements and their exact output forwarding. Never search a
 * script for tool-looking substrings: those may be quoted, conditional, or never called.
 * Groups preserve parallelism; output slots associate each receipt with its own arguments. */
export function literalToolCalls(raw: string): LiteralToolCall[] | null {
  if (raw.length > 128 * 1024) return null
  let source = raw.replace(/^\s*\/\/ @exec:[^\n]*\n/, '').trim()
  const calls: LiteralToolCall[] = []
  let group = 0, block = 0
  const fail = (): never => { throw new Error('Unsupported orchestration') }
  const take = (pattern: RegExp): RegExpExecArray | null => {
    source = source.trimStart()
    const match = pattern.exec(source)
    if (match) source = source.slice(match[0].length)
    return match
  }
  const need = (pattern: RegExp) => take(pattern) ?? fail()
  const call = (): LiteralToolCall => {
    const name = need(/^tools\.([a-zA-Z_][\w]*)\s*\(/)[1]
    const argument = literal(source.trimStart(), true)
    source = source.trimStart().slice(argument.length)
    need(/^\)/)
    if (calls.length >= 32) fail()
    const value = { name, input: argument.value, group }
    calls.push(value)
    return value
  }
  try {
    while (source.trim()) {
      if (take(/^\/\/[^\n]*(?:\n|$)/) || take(/^;/)) continue
      group++
      if (take(/^text\s*\(\s*await\s+/)) {
        call().output = { block: block++ }
        need(/^\)/); take(/^;/)
        continue
      }
      if (take(/^await\s+(?=tools\.)/)) {
        call(); take(/^;/) // No forwarded result: intent only, never a successful receipt.
        continue
      }
      const variable = need(/^(?:const|let)\s+([a-zA-Z_]\w*)\s*=\s*await\s+/)[1]
      const batch = take(/^Promise\.(allSettled|all)\s*\(\s*\[/)
      if (!batch) {
        const value = call()
        need(/^;/)
        need(new RegExp(`^text\\s*\\(\\s*${variable}\\s*\\)`)); take(/^;/)
        value.output = { block: block++ }
        continue
      }
      const first = calls.length
      while (!take(/^\]/)) { call(); if (!take(/^,/)) { need(/^\]/); break } }
      need(/^\)/); need(/^;/)
      // Common forwarding loops. Their bodies can only print the corresponding result, either
      // directly or tagged with its index. Extra code, filters and conditional output are rejected.
      const loop = take(new RegExp(`^for\\s*\\(\\s*let\\s+([a-zA-Z_]\\w*)\\s*=\\s*0\\s*;\\s*\\1\\s*<\\s*${variable}\\.length\\s*;\\s*\\1\\+\\+\\s*\\)\\s*(\\{)?\\s*text\\s*\\(\\s*\\{\\s*\\1\\s*,\\s*\\.\\.\\.${variable}\\[\\1\\]\\s*\\}\\s*\\)\\s*;?\\s*`))
      const plain = loop ? null : take(new RegExp(`^for\\s*\\(\\s*const\\s+([a-zA-Z_]\\w*)\\s+of\\s+${variable}\\s*\\)\\s*(\\{)?\\s*text\\s*\\(\\s*\\1\\s*\\)\\s*;?\\s*`))
      if (!loop && !plain) fail()
      if (loop && loop[1] !== 'i') fail() // The indexed receipt contract names its field `i`.
      if ((loop ?? plain)![2]) need(/^\}/)
      calls.slice(first).forEach((value, index) => {
        value.output = { block: block++, ...(batch[1] === 'allSettled' ? { settled: true } : {}),
          ...(loop ? { index } : {}) }
      })
    }
    return calls.length ? calls : null
  } catch { return null }
}
