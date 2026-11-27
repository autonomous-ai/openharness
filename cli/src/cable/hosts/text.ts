// The text a host path takes. The watch loads this file, so it imports nothing.

/**
 * The longest text any host path takes (observed.ts and each host's source and client). The dial records up to 10
 * minutes: fast speech (200 words a minute, ~6.5 characters a word) is about 13,000 characters, plus a carried passage
 * or selection (up to 4,096 bytes, each line quoted), plus margin. core/deviceHookCalls.ts holds the same number for
 * the mod's poll: the core imports nothing from cable/.
 */
export const MAX_TEXT = 20_000
// A newline would submit part of the text and an escape would steer the agent's screen: the text is typed as one line,
// and only the host's own submit sends it.
export const CONTROL = /\p{Cc}/gu
