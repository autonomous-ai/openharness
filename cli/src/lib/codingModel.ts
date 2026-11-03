/**
 * Whether a local model can drive a coding agent, beside the 64K context floor (`codingContext.ts`). 2026-10-24: a Builder
 * on llama3.2:3b, with a 128K window, made over a thousand requests for a one-line edit and never finished; a qwen3 4B
 * Builder timed out the day before. A model this small cannot keep up with a coding agent's tools and context, and one
 * that answers slowly has the grid's relay give up on it. Run for Swarm says why (desktop `lib/models/coding_model.dart`
 * holds the same rule), and since the project instructions the route still offers such a model, with this sentence as its
 * note: the agent choosing decides (phase 4, decision 19).
 */

/** Fewer parameters than this, and Claude Code or Codex goes round in circles. */
export const MIN_CODING_PARAMS_B = 7
/** Slower than this on the machine that runs it, and a turn outlasts what the relay waits for. */
export const MIN_CODING_TOK_S = 10

export interface CodingModelFacts {
  name: string; paramsB?: number; sizeBytes?: number; quantization?: string; tokensPerSecond?: number; estTokS?: number
}

/** Roughly how many bits a weight takes at [quant]: Q4 about 4.8, IQ4 about 4.3, MXFP4 4.25, half precision 16. */
function bitsPerWeight(quant = ''): number {
  const q = quant.toUpperCase()
  if (/MXFP4/.test(q)) return 4.25
  if (/BF16|FP16|F16/.test(q)) return 16
  const digit = /(IQ|Q)(\d)/.exec(q)
  return digit ? Number(digit[2]) + (digit[1] === 'IQ' ? 0.3 : 0.8) : 4.8
}

/** The parameter count a model's name gives (`llama3.2:3b`, `Qwen3.6-35B-A3B`: the total, not the active `A3B`). */
export function paramsFromName(name: string): number | undefined {
  const match = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/i.exec(name)
  return match ? Number(match[1]) : undefined
}

/** Billions of parameters: the model's own count, else its name's, else read off its weights and quant. */
export function paramsOf(m: CodingModelFacts): number | undefined {
  return m.paramsB ?? paramsFromName(m.name) ?? (m.sizeBytes ? m.sizeBytes * 8 / bitsPerWeight(m.quantization) / 1e9 : undefined)
}

/** Why [m] cannot drive a coding agent, in a sentence, or null when it can or nothing says otherwise. */
export function codingRefusal(m: CodingModelFacts): string | null {
  const params = paramsOf(m)
  if (params !== undefined && params < MIN_CODING_PARAMS_B) {
    return `${m.name} is too small for a coding agent (about ${Math.round(params * 10) / 10}B parameters; a coding agent needs ${MIN_CODING_PARAMS_B}B or more).`
  }
  const speed = m.tokensPerSecond ?? m.estTokS
  if (speed !== undefined && speed < MIN_CODING_TOK_S) {
    return `${m.name} is too slow on this computer for a coding agent (about ${Math.round(speed)} tok/s; a coding agent needs ${MIN_CODING_TOK_S} or more).`
  }
  return null
}
