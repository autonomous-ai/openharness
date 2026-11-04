import { expect, it, vi } from 'vitest'
import { prisma } from './prisma.js'

it('leaves the database connected on a shutdown signal, for the process to close after its drain', () => {
  const disconnect = vi.spyOn(prisma, '$disconnect').mockResolvedValue()
  try {
    // Only the listeners registered in this test process: nothing is signalled for real.
    process.emit('SIGTERM')
    process.emit('SIGINT')
    expect(disconnect).not.toHaveBeenCalled()
  } finally { disconnect.mockRestore() }
})
