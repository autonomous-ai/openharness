import type { FastifyReply } from 'fastify'
import type { ApiResponse } from '../types/index.js'

export function sendSuccess<T>(reply: FastifyReply, data: T, statusCode = 200): void {
  const response: ApiResponse<T> = { success: true, data }
  reply.code(statusCode).send(response)
}

/** `details` adds fields to the error beside its code, for a caller that acts on them (a stale roster's held version). */
export function sendError(reply: FastifyReply, message: string, code: string, statusCode = 500, details?: Record<string, unknown>): void {
  const response: ApiResponse<null> = { success: false, error: { ...details, code, message } }
  reply.code(statusCode).send(response)
}

export function sendCreated<T>(reply: FastifyReply, data: T): void {
  sendSuccess(reply, data, 201)
}
