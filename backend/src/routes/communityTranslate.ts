/**
 *   POST /api/community/translate   SSO access token → { title, description, conversation, translated }
 *
 * The Hub's publish page asks this once for a draft that arrived from Desktop or a bundle, so the
 * publication reads in English. The author sees the result, can go back to the original, and publishes
 * whichever they choose: nothing here stores or publishes anything.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { communityLimits } from '../lib/communityContract.js'
import { translateDraft, TranslationTooLong } from '../lib/communityTranslate.js'
import { acceptGzipJson } from '../lib/gzipJson.js'
import { harnessLlmConfigured } from '../lib/harnessLlm.js'
import { createRateLimiter } from '../lib/rateLimit.js'
import { validateBody } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { logger } from '../utils/logger.js'

export const COMMUNITY_TRANSLATE_PATH = '/api/community/translate'

/** A draft is translated once as it arrives, and again only when its author asks. */
const limiter = createRateLimiter('community-translate', 10 * 60_000, 10)
export const resetTranslateRateLimits = (): void => limiter.reset()

const bodySchema = z.object({
  title: z.string().max(100),
  description: z.string().max(300),
  conversation: z.array(z.object({ role: z.enum(['user', 'assistant', 'tool']), text: z.string().max(communityLimits.turnChars) }).strict()).max(communityLimits.turns),
}).strict()

export async function communityTranslateRoutes(app: FastifyInstance): Promise<void> {
  acceptGzipJson(app, 1_100_000)
  app.post<{ Body: z.infer<typeof bodySchema> }>(COMMUNITY_TRANSLATE_PATH, { bodyLimit: 1_100_000, preHandler: validateBody(bodySchema) }, async (req, reply) => {
    if (!harnessLlmConfigured()) {
      logger.error('community-translate: CURSOR_LLM_BASE_URL/CURSOR_LLM_API_KEY not configured — refusing')
      return sendError(reply, 'Translation is not available right now.', 'LLM_NOT_CONFIGURED', 503)
    }
    const userId = req.user!.sub
    if (!(await limiter.allows(userId))) return sendError(reply, 'Please wait before translating again.', 'RATE_LIMITED', 429)
    const started = Date.now()
    try {
      const result = await translateDraft(req.body)
      logger.info('community-translate', { userId, turns: req.body.conversation.length, translated: result.translated, ms: Date.now() - started })
      sendSuccess(reply, result)
    } catch (error) {
      if (error instanceof TranslationTooLong) return sendError(reply, 'This conversation is too long to translate automatically.', 'TOO_LONG', 413)
      logger.error('community-translate failed', { userId, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) })
      sendError(reply, 'The translation failed. Try again.', 'TRANSLATION_FAILED', 502)
    }
  })
}
