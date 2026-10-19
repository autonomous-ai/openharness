import { expect, it, vi } from 'vitest'
import { emptyPorts } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'
import { startSuperTabs } from './superTabs.js'

it('installs the same Super Tab handlers and stoppable lifetime in inline mode', async () => {
  const core = fakeCore(), ports = emptyPorts()
  const host = { machineId: 'machine-1', start: vi.fn(), stop: vi.fn() }
  const requests = startSuperTabs(core, ports, { host: () => host as never })
  expect(await requests.super_tabs({ action: 'wake' }, { owner: true, local: true })).toEqual({ ok: true })
  expect(host.start).toHaveBeenCalledOnce()
  ports.superTabs!.stop()
  expect(host.stop).toHaveBeenCalledOnce()
})
