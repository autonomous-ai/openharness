import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ValidationError } from '../errors/index.js'

/** The fields a request was refused for, by name only: a value may be a person's words or a credential. Zod's own first
 *  message ("Invalid input") does not say which field, and a host's start report was refused every few minutes in
 *  prod without anyone being able to tell why (2026-10-28). */
export function refusedFields(issues: readonly z.core.$ZodIssue[]): string[] {
  const names = issues.flatMap(issue => {
    const at = issue.path.map(String)
    if (issue.code === 'unrecognized_keys') return issue.keys.map(key => [...at, key].join('.'))
    return [at.join('.') || '(body)']
  })
  return [...new Set(names)].slice(0, 20)
}

/** `named` puts the failing field's path before zod's message, which alone ("expected number, received undefined") does not say which one. */
export function validateBody<T extends z.ZodTypeAny>(schema: T, options: { named?: boolean } = {}) {
  return async (request: FastifyRequest<{ Body: z.infer<T> }>, _reply: FastifyReply): Promise<void> => {
    const result = schema.safeParse(request.body)
    if (!result.success) {
      const issue = result.error.issues[0]
      const field = options.named && issue?.path.length ? `${issue.path.join('.')}: ` : ''
      throw new ValidationError(issue?.message ? `${field}${issue.message}` : 'Invalid request body', refusedFields(result.error.issues))
    }
    request.body = result.data as z.infer<T>
  }
}

export function validateParams<T extends z.ZodTypeAny>(schema: T) {
  return async (request: FastifyRequest<{ Params: z.infer<T> }>, _reply: FastifyReply): Promise<void> => {
    const result = schema.safeParse(request.params)
    if (!result.success) {
      throw new ValidationError(result.error.issues[0]?.message || 'Invalid request parameters', refusedFields(result.error.issues))
    }
    request.params = result.data as z.infer<T>
  }
}

export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return async (request: FastifyRequest<{ Querystring: z.infer<T> }>, _reply: FastifyReply): Promise<void> => {
    const result = schema.safeParse(request.query)
    if (!result.success) {
      throw new ValidationError(result.error.issues[0]?.message || 'Invalid query parameters', refusedFields(result.error.issues))
    }
    request.query = result.data as z.infer<T>
  }
}
