import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../errors/index.js'
import { sendError } from '../utils/response.js'
import { logger } from '../utils/logger.js'
import { SuperTabError } from '../superTabs/model.js'

/** The Swarm 503s that waiting fixes. Others (no attachment store, no picture uploads) are this server's setup. */
const RETRYABLE_SWARM_CODES = new Set(['SWARM_BUSY', 'SWARM_MIGRATING'])

/** How long a busy answer asks the caller to wait: just past the Swarm transaction's longest backoff (1.5 s). */
const BUSY_RETRY_AFTER_SECONDS = 2

/** A 503 the caller should simply try again: it carries Retry-After. Every client retries a 5xx (store.ts `transaction`). */
function sendBusy(reply: FastifyReply, message: string, code: string): void {
  reply.header('Retry-After', String(BUSY_RETRY_AFTER_SECONDS))
  sendError(reply, message, code, 503)
}

/** Prisma's own failure code, when the error is one. */
const prismaCode = (error: unknown): string | null => {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : null
  return typeof code === 'string' && /^P\d{4}$/.test(code) ? code : null
}

export async function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (error instanceof AppError) {
    logger.warn('Application error', {
      code: error.code,
      statusCode: error.statusCode,
      path: request.url,
      method: request.method,
      message: error.message,
    })
    sendError(reply, error.message, error.code || 'APP_ERROR', error.statusCode)
    return
  }

  // A Swarm refusal or busy answer thrown outside the Super Tab routes (the harness-shares list asks the Swarm store).
  if (error instanceof SuperTabError) {
    if (RETRYABLE_SWARM_CODES.has(error.code)) {
      logger.warn('Swarm busy', { code: error.code, path: request.url, method: request.method })
      return sendBusy(reply, error.message, error.code)
    }
    return sendError(reply, error.message, error.code, error.status)
  }

  // A database transaction that expired or could not start (P2028) is load, not a fault: the caller retries.
  // A unique key still taken after the retries (P2002) is a genuine duplicate: a conflict, never a 500.
  const prisma = prismaCode(error)
  if (prisma === 'P2028') {
    logger.warn('Database transaction expired or could not start', { path: request.url, method: request.method, message: error.message })
    return sendBusy(reply, 'The server is busy. Try again in a moment.', 'BUSY')
  }
  if (prisma === 'P2002') {
    logger.warn('Duplicate key', { path: request.url, method: request.method, message: error.message })
    return sendError(reply, 'This already exists, so nothing new was saved.', 'DUPLICATE', 409)
  }

  if (error.validation) {
    sendError(reply, error.validation[0]?.message || 'Validation failed', 'VALIDATION_ERROR', 400)
    return
  }

  // Fastify's own client errors (malformed JSON, unsupported media type, body too large) carry a 4xx
  // statusCode. Logging those at ERROR as "unhandled" buries real server faults in caller noise, and
  // reporting them as INTERNAL_ERROR tells the caller the wrong thing about whose fault it is.
  const status = error.statusCode ?? 500
  if (status >= 400 && status < 500) {
    logger.warn('Client error', {
      code: error.code, statusCode: status, path: request.url, method: request.method, message: error.message,
    })
    sendError(reply, error.message || 'Bad request', error.code || 'BAD_REQUEST', status)
    return
  }

  // The stack always, production too: an unhandled 500 is a bug, and its message alone rarely says where.
  logger.error('Unhandled error', error, { name: error.name, path: request.url, method: request.method, trace: error.stack })
  // Only hide the real message in explicit production. Local dev often has NODE_ENV unset, and masking
  // there just surfaces a useless "internal server error" to the caller (e.g. the UI toast).
  const hideDetail = process.env.NODE_ENV === 'production'
  sendError(reply, hideDetail ? 'An internal server error occurred' : (error.message || 'Internal error'), 'INTERNAL_ERROR', error.statusCode || 500)
}
