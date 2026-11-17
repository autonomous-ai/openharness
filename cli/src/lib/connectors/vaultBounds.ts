/** Existing backend connector-vault v1 limits, before allocating decoded or parsed secret content. */
export const VAULT_CIPHERTEXT_CHARS = 1_000_000
export const VAULT_PLAINTEXT_BYTES = Math.floor(VAULT_CIPHERTEXT_CHARS / 4) * 3 - 16
