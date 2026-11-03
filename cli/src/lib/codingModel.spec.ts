import { describe, expect, it } from 'vitest'
import { codingRefusal, paramsFromName, paramsOf } from './codingModel.js'

const GB = 1e9

describe('a local model that can drive a coding agent', () => {
  it('reads the parameter count off a name, the total and never an active count', () => {
    expect(paramsFromName('llama3.2:3b')).toBe(3)
    expect(paramsFromName('Qwen3.6-35B-A3B')).toBe(35)
    expect(paramsFromName('Qwen3-4B-Instruct-2507')).toBe(4)
    expect(paramsFromName('qwen2.5-coder:7b-instruct')).toBe(7)
    expect(paramsFromName('mixtral-8x7b')).toBeUndefined()
    expect(paramsFromName('gemma-4-E2B-it')).toBeUndefined()
    expect(paramsFromName('Llama-3.3-70B')).toBe(70)
  })

  it('counts parameters from the model, its name, else its weights and quant', () => {
    expect(paramsOf({ name: 'x', paramsB: 12 })).toBe(12)
    expect(paramsOf({ name: 'llama3.2:3b', sizeBytes: 40 * GB })).toBe(3)
    expect(paramsOf({ name: 'gemma-4-E2B-it', sizeBytes: 3.2 * GB })).toBeCloseTo(5.33, 1)
    expect(paramsOf({ name: 'm', sizeBytes: 16 * GB, quantization: 'BF16' })).toBeCloseTo(8)
    expect(paramsOf({ name: 'm', sizeBytes: 4.25 * GB, quantization: 'MXFP4' })).toBeCloseTo(8)
    expect(paramsOf({ name: 'm', sizeBytes: 4.3 * GB, quantization: 'IQ4_XS' })).toBeCloseTo(8)
    expect(paramsOf({ name: 'm', sizeBytes: 8.8 * GB, quantization: 'Q8_0' })).toBeCloseTo(8)
    expect(paramsOf({ name: 'm' })).toBeUndefined()
  })

  it('refuses a model too small or too slow, and says why; anything unknown passes', () => {
    // Said of the model, in no role's name (project instructions, phase 4): the route offers it with this note.
    expect(codingRefusal({ name: 'llama3.2:3b' })).toBe('llama3.2:3b is too small for a coding agent (about 3B parameters; a coding agent needs 7B or more).')
    expect(codingRefusal({ name: 'Qwen3.6-35B-A3B', estTokS: 4.4 }))
      .toBe('Qwen3.6-35B-A3B is too slow on this computer for a coding agent (about 4 tok/s; a coding agent needs 10 or more).')
    expect(codingRefusal({ name: 'Qwen3.6-35B-A3B', estTokS: 4, tokensPerSecond: 40 })).toBeNull()
    expect(codingRefusal({ name: 'Qwen3.6-35B-A3B', estTokS: 30 })).toBeNull()
    expect(codingRefusal({ name: 'mystery' })).toBeNull()
  })
})
