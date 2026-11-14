/**
 * The longest one call to a speech-to-text service may take, retries and their waits included. A silent service fails the call
 * instead of holding it, and with it what the call holds (the dial's utterance, a voice route's request) until the connection
 * gives up on its own, minutes later.
 */
export const STT_TIMEOUT_MS = 60_000
