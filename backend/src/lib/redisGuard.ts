import { ReplyError, type Command, type Redis } from 'ioredis'
import { CircuitOpenError, type CircuitBreaker } from './circuitBreaker.js'

/**
 * Puts a circuit breaker in front of every command a Redis connection sends (Stability 3.5).
 *
 * The bus' command connection already fails fast while Redis is away (no offline queue). A Redis that is up but stuck
 * is worse: each command waits out the command timeout. Through the breaker the first few do, then commands are refused
 * before they are written until Redis has had time to recover. Callers already treat a failed command as "unknown".
 *
 * Every command goes through `sendCommand`, so this one place covers the bus and every module that borrows its
 * connection. A transaction or pipeline (`sendCommand` with a stream) passes untouched: refusing one of its commands
 * would split the batch it writes at once. It still has the command timeout. So do the commands ioredis sends while it
 * (re)connects (its ready check, SELECT): refusing those would keep a recovered Redis from ever becoming ready. A
 * command of ours on a connection that is not ready fails at once anyway, with no offline queue.
 */
export function guardRedisCommands(redis: Redis, breaker: CircuitBreaker): void {
  const send = redis.sendCommand.bind(redis)
  redis.sendCommand = ((command: Command, stream?: unknown, node?: unknown) => {
    if (stream || redis.status !== 'ready') return (send as (c: Command, s?: unknown, n?: unknown) => unknown)(command, stream, node)
    breaker.run(() => {
      send(command)
      return command.promise
    }).catch((err: unknown) => {
      if (err instanceof CircuitOpenError) command.reject(err)
    })
    return command.promise
  }) as Redis['sendCommand']
}

/** Whether a Redis command failed for the connection, not with an answer: a reply error is Redis working. */
export const isRedisFailure = (err: unknown): boolean => !(err instanceof ReplyError)

/** True only when the command certainly never reached Redis, so doing its work another way cannot do it twice. A
 *  timed-out command may still have been delivered. */
export function wasNotSent(err: unknown): boolean {
  return err instanceof CircuitOpenError || (err instanceof Error && err.message.startsWith("Stream isn't writeable"))
}
