/**
 * The longest one call to a speech-to-text service may take. A silent service fails the call instead of holding it, and with it
 * what the call holds: a chat voice message's memory slot and its claim (superTabs/store.ts readVoice). Under the claim's
 * VOICE_CLAIM_MS (2 minutes), so a call is over before another may claim the same file.
 */
export const STT_TIMEOUT_MS = 90_000
