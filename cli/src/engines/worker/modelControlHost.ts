import type { ModelControlHost } from '../facets/modelControl.js'
import { RuntimeProfileControlError } from '../facets/modelControl.js'
import type { RuntimeCatalogModel } from '../facets/runtime.js'
import { modelControlAnswer, modelControlEnvelope, type ModelControlAction } from './modelControlProtocol.js'

/** Shared by worker and explicit inline mode. Each call still passes through core's grant broker. */
export function createModelControlHost(ask: (action: ModelControlAction) => Promise<Record<string, unknown>>): ModelControlHost {
  const call = async (action: ModelControlAction) => {
    const reply = await ask(action)
    if (!modelControlEnvelope(reply, ['value', 'error']) || reply.error !== undefined || !modelControlAnswer(action, reply.value)) {
      throw new RuntimeProfileControlError('BUSY')
    }
    return reply.value
  }
  return {
    catalog: async () => await call({ kind: 'catalog' }) as RuntimeCatalogModel[],
    capture: async lines => await call({ kind: 'capture', lines }) as string | null,
    text: async text => await call({ kind: 'text', text }) as boolean,
    key: async key => await call({ kind: 'key', key }) as boolean,
    waitForModel: async ms => await call({ kind: 'waitForModel', ms }) as boolean,
    waitForProfile: async ms => await call({ kind: 'waitForProfile', ms }) as boolean,
    confirmEffort: async effort => { if (!await call({ kind: 'confirmEffort', effort })) throw new RuntimeProfileControlError('BUSY') },
  }
}
