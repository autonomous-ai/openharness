/** What a person's device hears when a person is needed (collaboration protocol): a decision or hands-on request asked of
 *  them, its 30-minute reminder, or a mention. Never its content: the device opens the request through the person's own
 *  read, which checks access again. The device builder plugs in through SuperTabStoreHooks.personNeeded; the device decides
 *  what to show (hands-on always, decisions and mentions if the person opts in). */
export interface PersonSignal {
  tabId: string
  personId: string
  /** The decision or hands-on request id, or the mention id. */
  requestId: string
  kind: 'decision' | 'handsOn' | 'mention'
  reason: 'asked' | 'reminder'
}
