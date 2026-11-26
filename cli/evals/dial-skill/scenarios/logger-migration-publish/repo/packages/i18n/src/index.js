import { scoped } from '../../../lib/logger-v1.js'

const log = scoped('[i18n]')

// The message for key in locale, else in English, else the key itself.
export function translate(messages, locale, key) {
  const own = messages[locale]?.[key]
  const text = own ?? messages.en?.[key]
  if (text === undefined) {
    log.error('missing message %s', key)
    return key
  }
  if (own === undefined) log.warn('fell back to en', { locale, key })
  return text
}
