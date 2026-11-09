/**
 * The longest one call to a speech-to-text service may take, retries and their waits included. A silent service fails the call
 * instead of holding it, and with it what the call holds: a chat voice message's memory slot and its claim (superTabs/store.ts
 * readVoice). The claim lasts VOICE_CLAIM_MS (2 minutes) and starts before the file is read from the bucket and the quota
 * reserved, so a call is limited to half of it: another call cannot claim the same file while this one still runs.
 */
export const STT_TIMEOUT_MS = 60_000
