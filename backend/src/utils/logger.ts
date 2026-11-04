type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogContext {
  [key: string]: unknown
}

/**
 * One line per log, in one of two shapes.
 *
 * In the cluster: JSON, because that is what Datadog can read. It parses a JSON line into
 * attributes, so `logger.info('web user disconnected', { userId })` becomes something you can filter
 * with `@userId` and group by. `message` and `status` are the names it reads for the text and the
 * level; every other key becomes an attribute of its own. The old format — `[ts] [INFO] text {json}`
 * — arrived as one string, so the context was text nobody could query.
 *
 * Anywhere else (a terminal, the tests): that readable line, unchanged. `npm run dev` should not be
 * a wall of JSON.
 */
export class Logger {
  private isDevelopment = process.env.NODE_ENV === 'development'

  constructor(private readonly asJson: boolean = process.env.NODE_ENV === 'production') {}

  private write(level: LogLevel, to: (line: string) => void, message: string, context?: LogContext): void {
    const timestamp = new Date().toISOString()
    if (this.asJson) {
      // Context first: a field called `message` or `status` is data about the event, and must not
      // take the place of the event's own message or level.
      to(JSON.stringify({ ...context, timestamp, status: level, message }))
      return
    }
    to(`[${timestamp}] [${level.toUpperCase()}] ${message}${context ? ` ${JSON.stringify(context)}` : ''}`)
  }

  debug(message: string, context?: LogContext): void {
    if (this.isDevelopment) this.write('debug', (line) => console.debug(line), message, context)
  }

  info(message: string, context?: LogContext): void {
    this.write('info', (line) => console.log(line), message, context)
  }

  warn(message: string, context?: LogContext): void {
    this.write('warn', (line) => console.warn(line), message, context)
  }

  error(message: string, error?: Error | unknown, context?: LogContext): void {
    let errorContext: LogContext
    if (error instanceof Error) {
      errorContext = { ...context, error: error.message, stack: this.isDevelopment ? error.stack : undefined }
    } else if (error && typeof error === 'object') {
      const errorObj = error as Record<string, unknown>
      errorContext = { ...context, error: errorObj.message || errorObj.code || JSON.stringify(error) }
    } else if (error !== undefined) {
      errorContext = { ...context, error: String(error) }
    } else {
      errorContext = { ...context }
    }
    this.write('error', (line) => console.error(line), message, errorContext)
  }
}

export const logger = new Logger()
