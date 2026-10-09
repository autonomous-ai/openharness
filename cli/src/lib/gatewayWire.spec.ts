import { describe, expect, it } from 'vitest'
import { decodeGatewayBinary, encodeGatewayBinary, GatewayBinary } from './gatewayWire.js'

describe('the gateway\'s binary frames', () => {
  it('carries a viewer surface\'s frame parts, and still refuses a kind it does not know', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(decodeGatewayBinary(encodeGatewayBinary(GatewayBinary.viewer, 'conn-1', bytes)!)).toEqual({ kind: GatewayBinary.viewer, id: 'conn-1', bytes })
    expect(decodeGatewayBinary(encodeGatewayBinary(4 as GatewayBinary, 'conn-1', bytes)!)).toBeNull()
  })
})
