/** A bounded text-inference capability supplied by the optional application. */
export type TextInference = (prompt: string, opts: { timeoutMs: number; signal: AbortSignal }) => Promise<string | null>
